import type {
  BinaryFrameHeader,
  ParsedBinaryFrame,
} from "@circuitlab/pigeon-message";

export type PigeonOptions = {
  baseUrl: string;
  address: string;
  staticId?: string;
  autoReconnect?: boolean | AutoReconnectOptions;
  /**
   * Prove the connection is alive rather than assume it. Pass `true` (or
   * `{ intervalMs, staleMs }`) to ping the host on an interval and force a
   * reconnect when nothing comes back for `staleMs`. Off by default.
   */
  keepAlive?: boolean | KeepAliveOptions;
  /**
   * Hold messages sent while the socket is down and flush them on reconnect,
   * instead of throwing. Pass `true` (or `{ limit }`) to enable. Off by
   * default.
   */
  sendQueue?: boolean | SendQueueOptions;
};

export type AutoReconnectOptions = {
  /**
   * Maximum number of reconnect attempts before giving up. Defaults to
   * `Infinity` (retry forever).
   */
  maxAttempts?: number;
  /**
   * Also reconnect when the peer closes the connection *cleanly*. Defaults to
   * `false`, which treats a clean close as "the room meant it".
   *
   * Set this when the room may close a connection it still expects to keep —
   * `@circuitlab/pigeon-room` up to v1.1.4 reaps any peer that has not *sent*
   * anything for 75 s with a clean close, which a receive-only or idle
   * publisher hits routinely. With `keepAlive` on, that reaper should never
   * fire; this is the belt to its braces.
   */
  onCleanClose?: boolean;
};

export type KeepAliveOptions = {
  /**
   * How often to ping the host, in milliseconds. Defaults to `30000`.
   *
   * The ping does double duty: it advances the room's own idle clock (a
   * write-only publisher would otherwise be reaped in a quiet hour), and it
   * draws a `pong` back that proves the return path.
   */
  intervalMs?: number;
  /**
   * How long the room may go without sending *any* frame before the socket is
   * treated as half-open and closed so the reconnect path runs. Defaults to
   * `90000`, or `intervalMs * 2` when that is larger.
   *
   * This is the failure a `readyState` check cannot see: when the TCP path is
   * dropped silently, neither `close` nor `error` fires, the socket stays
   * `OPEN`, and everything sent from then on goes nowhere.
   */
  staleMs?: number;
  /**
   * How long a socket may sit in `CONNECTING` before the attempt is abandoned
   * and the next one scheduled. Defaults to `staleMs`.
   *
   * A WebSocket handshake has no timeout of its own, and the network that just
   * ate a live connection will happily eat the handshake that tries to replace
   * it — leaving a socket stuck at `CONNECTING` with no `open`, no `error` and
   * no `close` to react to. Without this, healing a half-open socket only
   * moves where it hangs.
   */
  connectTimeoutMs?: number;
};

export type SendQueueOptions = {
  /**
   * Maximum messages to hold while disconnected. Further sends are dropped
   * (and counted in `stats().dropped`) rather than growing without bound.
   * Defaults to `1000`.
   */
  limit?: number;
  /**
   * Maximum total bytes to hold while disconnected. Defaults to `8388608`
   * (8 MB).
   *
   * A message count alone is not a bound when binary frames are in play: a
   * thousand queued depth-frames is a hundred megabytes. Whichever bound is
   * reached first starts dropping.
   */
  maxBytes?: number;
};

/**
 * A point-in-time view of the connection, for a status endpoint or a
 * dashboard. `queued` (socket down) and `buffered` (socket open but behind)
 * are the two shapes congestion takes; either one climbing means the room is
 * not carrying what this client is producing.
 */
export type PigeonStats = {
  /**
   * Whether this client has *joined* — the `init` handshake completed — which
   * is the question a status page is really asking. It can be `false` while
   * `socketOpen` is `true`: see the `staticId` note in CHANGELOG 0.4.0, where
   * a rejoin shadowed by its own ghost holds an open socket that never
   * receives its `init`.
   */
  connected: boolean;
  /** Whether the underlying socket is `OPEN`, regardless of the handshake.
   *  Tells "no connection" apart from "connection, no room". */
  socketOpen: boolean;
  /** Messages waiting for the socket to come back. Always 0 without `sendQueue`. */
  queued: number;
  /** Bytes those queued messages account for. */
  queuedBytes: number;
  /** Bytes the socket itself has not flushed to the network yet. */
  buffered: number;
  sent: number;
  sentBytes: number;
  /** Messages discarded because the queue was full. */
  dropped: number;
  /** Milliseconds since the room last sent anything; `null` while disconnected. */
  inboundAgeMs: number | null;
  /** The configured stale threshold, or `null` when `keepAlive` is off. */
  staleMs: number | null;
};

export type MessageBody =
  | string
  | number
  | boolean
  | null
  | MessageBody[]
  | { [k: string]: MessageBody };

export const isMessageBody = (
  x: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): x is MessageBody => {
  if (x === null) return true;
  const t = typeof x;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(x)) return x.every((v) => isMessageBody(v, seen));
  if (t === "object") {
    const o = x as Record<string, unknown>;
    if (seen.has(o)) return false;
    seen.add(o);
    for (const k in o) {
      if (!isMessageBody(o[k]!, seen)) return false;
    }
    return true;
  }
  return false;
};

export type ReceivedMessage<T extends MessageBody = MessageBody> = {
  address: string;
  body: T;
  from: string;
  timestamp: number;
  to: string[];
  type: string;
};

export type SendMessage<T extends MessageBody = MessageBody> = {
  body: T;
  to: string[];
  type: string;
};

// ============================================================
// Binary frames
// ============================================================
//
// The spec (`@circuitlab/pigeon-message`) owns the format and the header type
// but ships no codec; `_internal/binaryFrame.ts` is this package's half of it.
// The types below are re-exported so callers get them from `pigeon-link`
// without a second import.

export type { BinaryFrameHeader, ParsedBinaryFrame };

/**
 * A binary frame as received from the room: the header envelope, flattened,
 * plus the raw payload.
 *
 * `from` and `address` are set by the room on relay, and `ver` comes from the
 * frame's leading version byte. They are optional because the spec types them
 * that way and a client should not drop a frame over a missing stamp — in
 * practice `pigeon-room` sets both. **`timestamp` is not stamped on binary
 * frames** (the room only sets it on text), so treat its absence as normal.
 *
 * `payload` is a view onto the received buffer, not a copy. Reading it is
 * free; holding it past the handler holds the whole frame alive, so copy out
 * what you need if you intend to keep it.
 */
export type ReceivedBinaryMessage<T extends MessageBody = MessageBody> = {
  type: string;
  to: string[];
  body: T;
  from?: string;
  address?: string;
  timestamp?: number;
  payloadMeta?: unknown;
  payload: Uint8Array;
  /** Format version, from the frame's leading `ver` byte. */
  ver: number;
};

/**
 * What a client provides when sending a binary frame. `from` / `address` /
 * `timestamp` are omitted deliberately — the room stamps them on relay.
 *
 * `payloadMeta` is an optional, application-defined description of the payload
 * (a common convention is `{ name, mimeType }`). It rides in the header, which
 * is capped at 65535 bytes, so keep bulk data in the payload.
 */
export type SendBinaryMessage<T extends MessageBody = MessageBody> = {
  type: string;
  to: string[];
  body: T;
  payloadMeta?: unknown;
};

export type DisconnectReason = {
  code: number;
  reason: string;
  wasClean: boolean;
};
