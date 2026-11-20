import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalNotification } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  createNotification: vi.fn(),
  getActorById: vi.fn(),
  getObjectById: vi.fn(),
  broadcastNotificationEvent: vi.fn(),
  deliverPushSafe: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createNotification: mocks.createNotification,
  getActorById: mocks.getActorById,
  getObjectById: mocks.getObjectById,
}));

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: mocks.broadcastNotificationEvent,
}));

vi.mock("@/lib/push", () => ({
  deliverPushSafe: mocks.deliverPushSafe,
}));

import { notify } from "@/lib/notify";

const notif: LocalNotification = {
  id: "n1",
  type: "follow",
  accountId: "https://cf-ap.com/users/alice",
  targetAccountId: "https://cf-ap.com/users/bob",
  objectId: null,
  read: false,
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.broadcastNotificationEvent.mockResolvedValue(undefined);
  mocks.deliverPushSafe.mockResolvedValue(undefined);
});

describe("notify", () => {
  it("never throws when the record cannot be stored", async () => {
    // The caller's action (a follow, a call) is already committed: a failed
    // insert must not turn it into a 500 the client would retry.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createNotification.mockRejectedValue(new Error("no such column: call_status"));

    await expect(notify({ DB: {} as never }, notif)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
    expect(mocks.broadcastNotificationEvent).not.toHaveBeenCalled();
    expect(mocks.deliverPushSafe).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("stays silent when the insert was ignored (duplicate or filtered)", async () => {
    mocks.createNotification.mockResolvedValue(false);

    await notify({ DB: {} as never }, notif);

    expect(mocks.broadcastNotificationEvent).not.toHaveBeenCalled();
  });

  it("streams the full entity when the record was stored", async () => {
    mocks.createNotification.mockResolvedValue(true);
    mocks.getActorById.mockImplementation(async (_db: unknown, id: string) =>
      id === notif.accountId ? { id, username: "alice", isLocal: true, domain: "cf-ap.com" } : null
    );

    await notify(
      {
        DB: {} as never,
        INSTANCE_URL: "https://cf-ap.com",
        TIMELINE_STREAM: {} as never,
      },
      notif
    );

    expect(mocks.broadcastNotificationEvent).toHaveBeenCalledTimes(1);
    const [ns, target, payload] = mocks.broadcastNotificationEvent.mock.calls[0] as [
      unknown,
      string,
      string
    ];
    expect(ns).toEqual({});
    expect(target).toBe(notif.targetAccountId);
    expect(JSON.parse(payload).type).toBe("follow");
  });
});
