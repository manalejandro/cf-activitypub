import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCall } from "@/lib/webrtc/use-call";

/**
 * The hook drives a real RTCPeerConnection, WebSocket and getUserMedia, none
 * of which jsdom implements. These stand-ins record the calls the hook makes
 * so the phase machine can be exercised without a browser.
 */

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState = "new";
  ontrack: ((ev: unknown) => void) | null = null;
  onicecandidate: ((ev: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  remoteDescriptions: unknown[] = [];
  addTransceiver = vi.fn();
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" }));
  createAnswer = vi.fn(async () => ({ type: "answer", sdp: "answer-sdp" }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async (desc: unknown) => {
    this.remoteDescriptions.push(desc);
  });
  addIceCandidate = vi.fn(async () => {});
  getSenders = vi.fn(() => []);
  close = vi.fn();
  constructor() {
    FakePeerConnection.instances.push(this);
  }
}

class FakeMediaStream {
  private tracks: Array<{ kind: string; stop: () => void }>;
  constructor(tracks: Array<{ kind: string; stop: () => void }> = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(track: { kind: string; stop: () => void }) {
    this.tracks.push(track);
  }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: unknown = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
}

function fakeTrack(kind: string) {
  return { kind, stop: vi.fn(), enabled: true };
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
  } as unknown as Response;
}

/** Server state of the call created by `startCall` ("requested" holds it). */
let createdState: "requested" | "pending" = "requested";
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/ice-servers")) return jsonResponse({ iceServers: [] });
  if (url === "/api/v1/calls" && init?.method === "POST") {
    return jsonResponse({ id: "call-1", state: createdState });
  }
  return jsonResponse({});
});

beforeEach(() => {
  createdState = "requested";
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];
  fetchMock.mockClear();
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", {
    ...globalThis.navigator,
    mediaDevices: {
      getUserMedia: vi.fn(async () => new FakeMediaStream([fakeTrack("audio")])),
      getDisplayMedia: vi.fn(async () => new FakeMediaStream([fakeTrack("video")])),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function startHeldCall() {
  const hook = renderHook(() => useCall("token"));
  await act(async () => {
    await hook.result.current.startCall("bob", "audio");
  });
  return hook;
}

describe("useCall streaming events", () => {
  it("accepts call.answered while the callee is still approving (requesting)", async () => {
    const { result, unmount } = await startHeldCall();
    expect(result.current.callState.phase).toBe("requesting");

    await act(async () => {
      result.current.handleStreamingEvent(
        "call",
        JSON.stringify({ type: "call.answered", callId: "call-1", answerSdp: "remote-answer" })
      );
      // Let the setRemoteDescription().then() chain flush.
      await Promise.resolve();
    });

    expect(result.current.callState.phase).toBe("active");
    const pc = FakePeerConnection.instances[0];
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "remote-answer" });
    unmount();
  });

  it("moves a held request to calling when the callee approves it", async () => {
    const { result, unmount } = await startHeldCall();
    expect(result.current.callState.phase).toBe("requesting");

    await act(async () => {
      result.current.handleStreamingEvent(
        "call",
        JSON.stringify({ type: "call.ringing", callId: "call-1" })
      );
    });

    expect(result.current.callState.phase).toBe("calling");
    unmount();
  });

  it("ends the call with the peer's refusal reason", async () => {
    const { result, unmount } = await startHeldCall();

    await act(async () => {
      result.current.handleStreamingEvent(
        "call",
        JSON.stringify({ type: "call.rejected", callId: "call-1", reason: "busy" })
      );
    });

    expect(result.current.callState).toEqual({ phase: "ended", reason: "busy" });
    unmount();
  });

  it("ignores an answer for a call this device is not in", async () => {
    const { result, unmount } = await startHeldCall();

    await act(async () => {
      result.current.handleStreamingEvent(
        "call",
        JSON.stringify({ type: "call.answered", callId: "someone-else", answerSdp: "sdp" })
      );
    });

    expect(result.current.callState.phase).toBe("requesting");
    unmount();
  });
});
