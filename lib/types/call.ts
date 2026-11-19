/**
 * Call session data stored in Workers KV.
 * Key: call:{uuid}  — TTL 600 s (10 min)
 */
export type CallType = "audio" | "video" | "screen";

/**
 * Outcome of a call from the callee's point of view. The notification row is
 * created when the offer arrives (`ringing`/`requested`) and updated in place
 * as the call progresses, so a callee who was offline still finds the record.
 */
export type CallStatus =
  | "ringing"
  | "requested"
  | "answered"
  | "declined"
  | "missed"
  | "unanswered";

export interface CallSession {
  id: string;
  callerId: string;      // AP actor IRI
  calleeId: string;      // AP actor IRI (or acct for remote actors)
  callerAcct: string;    // "alice" (local) or "alice@remote" (cross-instance)
  calleeAcct: string;
  callType: CallType;
  offerSdp: string;
  answerSdp: string | null;
  /** `requested`: the callee set the "ask first" policy and has not approved yet. */
  state: "pending" | "requested" | "active" | "ended" | "rejected";
  createdAt: string;     // ISO-8601
}

/** WebRTC signal message exchanged via the CallSignalingDO WebSocket. */
export interface CallSignal {
  type: "offer" | "answer" | "ice" | "hangup";
  callId?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  reason?: string;
}

/**
 * Event payload sent to the callee's home streaming channel.
 * `call.request` is the same offer, held for approval by the "ask first" policy.
 */
export interface CallIncomingEvent {
  type: "call.incoming" | "call.request";
  callId: string;
  callType: CallType;
  callerAcct: string;
  callerDisplayName: string;
  callerAvatar: string | null;
  offerSdp: string;
}

export type CallEventPayload =
  | CallIncomingEvent
  | { type: "call.pending"; callId: string }
  | { type: "call.ringing"; callId: string }
  | { type: "call.answered"; callId: string; answerSdp: string }
  /** `reason` is the peer's refusal (`blocked`, `nobody`, `media_disabled`, `busy`). */
  | { type: "call.rejected"; callId: string; reason?: string }
  | { type: "call.ended"; callId: string }
  | { type: "call.ice"; callId: string; candidate: RTCIceCandidateInit }
  | { type: "call.renegotiate"; callId: string; sdp: string }
  | { type: "call.renegotiate-answer"; callId: string; sdp: string };
