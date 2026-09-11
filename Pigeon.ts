import type {
  DisconnectReason,
  MessageBody,
  ParsedBinaryFrame,
  PigeonOptions,
  PigeonStats,
  ReceivedBinaryMessage,
  ReceivedMessage,
  SendBinaryMessage,
  SendMessage,
} from "./types.ts";
import {
  generateSubsets,
  normalizeFilter,
  RECEIVE_FILTERABLE_KEYS,
  SEND_FILTERABLE_KEYS,
} from "./_internal/filter.ts";
import { parseReceiveMessage } from "./_internal/parseMessage.ts";
import { MessageListenerRegistry } from "./_internal/MessageListenerRegistry.ts";
import { buildBinaryFrame, parseBinaryFrame } from "./_internal/binaryFrame.ts";
import { utf8ByteLength } from "./_internal/utf8.ts";
import { FORMAT_VERSION } from "@circuitlab/pigeon-message";

const RECONNECT_INITIAL_DELAY = 500;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_BACKOFF_FACTOR = 2;

const KEEPALIVE_DEFAULT_INTERVAL_MS = 30_000;
const KEEPALIVE_DEFAULT_STALE_MS = 90_000;

const QUEUE_DEFAULT_LIMIT = 1_000;
const QUEUE_DEFAULT_MAX_BYTES = 8_388_608;

/** A socket this far behind is not keeping up with what we hand it. We warn
 *  rather than drop: what to shed is the application's call, and it can only
 *  make it on evidence. */
const BUFFER_WARN_BYTES = 1_048_576;
const WARN_INTERVAL_MS = 5_000;

type QueuedFrame = {
  data: string | ArrayBuffer;
  bytes: number;
  onSent?: () => void;
};

class Pigeon {
  public id: string | undefined;
  public isConnected: boolean = false;
  public socket!: WebSocket;

  private options: PigeonOptions;
  private autoReconnect: boolean;
  private autoReconnectMaxAttempts: number;
  private reconnectOnCleanClose: boolean;
  private destroyed = false;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private socketAbort: AbortController | undefined;

  private keepAlive:
    | { intervalMs: number; staleMs: number; connectTimeoutMs: number }
    | null;
  private lastInboundAt = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;

  private queueLimit: number;
  private queueMaxBytes: number;
  private queue: QueuedFrame[] = [];
  private queuedBytes = 0;

  private flow = { sent: 0, sentBytes: 0, dropped: 0 };
  private lastWarnAt: Record<string, number> = {};

  private events = new EventTarget();
  private receiveListeners = new MessageListenerRegistry<ReceivedMessage>(
    "pigeon:receive",
    this.events,
  );
  private receiveBinaryListeners = new MessageListenerRegistry<
    ReceivedBinaryMessage
  >(
    "pigeon:receive-binary",
    this.events,
  );
  private sendListeners = new MessageListenerRegistry<SendMessage>(
    "pigeon:send",
    this.events,
  );
  private connectMap: Map<unknown, EventListener> = new Map();
  private disconnectMap: Map<unknown, EventListener> = new Map();

  constructor(pigeonOptions: PigeonOptions) {
    console.log("pigeon link v0.4.0");
    this.options = pigeonOptions;
    const ar = pigeonOptions.autoReconnect;
    if (!ar) {
      this.autoReconnect = false;
      this.autoReconnectMaxAttempts = 0;
      this.reconnectOnCleanClose = false;
    } else {
      this.autoReconnect = true;
      this.autoReconnectMaxAttempts =
        (ar === true ? undefined : ar.maxAttempts) ?? Infinity;
      this.reconnectOnCleanClose =
        (ar === true ? undefined : ar.onCleanClose) ?? false;
    }

    const ka = pigeonOptions.keepAlive;
    if (!ka) {
      this.keepAlive = null;
    } else {
      this.keepAlive = this.resolveKeepAlive(ka === true ? {} : ka);
      if (!this.autoReconnect) {
        // The watchdog's whole job is to end a connection that has stopped
        // carrying anything, on the assumption that something will start a new
        // one. Without autoReconnect nothing does, so keepAlive would take the
        // client permanently offline rather than heal it.
        console.warn(
          "Pigeon: `keepAlive` without `autoReconnect` will close a stalled " +
            "socket and not reopen it. Enable `autoReconnect`, or call " +
            "`reopen()` from an `addDisconnectListener` handler.",
        );
      }
    }

    const sq = pigeonOptions.sendQueue;
    if (!sq) {
      this.queueLimit = 0;
      this.queueMaxBytes = 0;
    } else {
      this.queueLimit = (sq === true ? undefined : sq.limit) ??
        QUEUE_DEFAULT_LIMIT;
      this.queueMaxBytes = (sq === true ? undefined : sq.maxBytes) ??
        QUEUE_DEFAULT_MAX_BYTES;
    }

    try {
      this.openSocket();
    } catch (e) {
      if (e instanceof Error) {
        throw e;
      }
      throw new Error("unknown error");
    }

    this.addReceiveMessageListener<{
      id: string;
      clients: string[];
    }>({ type: "init" }, (message) => {
      if (message.from === "host") {
        this.id = message.body.id;
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.clearConnectTimer();
        this.events.dispatchEvent(new CustomEvent("pigeon:connect"));
      }
    });

    this.addReceiveMessageListener({ type: "ping" }, (message) => {
      // Handlers run in a microtask, so the socket can have gone since the
      // frame arrived. A pong is only worth anything on the connection that
      // asked for it — never queue it for the next one.
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      this.pong([message.from]);
    });
  }

  /**
   * Resolves and sanity-checks the keepAlive timings.
   *
   * These are clamped rather than trusted because a bad combination does not
   * fail loudly — it fails as a healthy connection being torn down on the
   * watchdog's first tick, on every generation, which reads from the outside
   * exactly like the network problem keepAlive exists to survive. In
   * particular `staleMs` must outlast a full ping interval plus the round trip
   * it is waiting on, or the check runs before its own evidence can arrive.
   */
  private resolveKeepAlive(
    ka: { intervalMs?: number; staleMs?: number; connectTimeoutMs?: number },
  ): { intervalMs: number; staleMs: number; connectTimeoutMs: number } {
    let intervalMs = ka.intervalMs ?? KEEPALIVE_DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      console.warn(
        `Pigeon: keepAlive.intervalMs must be a positive number (got ${ka.intervalMs}); ` +
          `using ${KEEPALIVE_DEFAULT_INTERVAL_MS} ms.`,
      );
      intervalMs = KEEPALIVE_DEFAULT_INTERVAL_MS;
    }

    const staleFloor = intervalMs * 2;
    let staleMs = ka.staleMs ??
      Math.max(KEEPALIVE_DEFAULT_STALE_MS, staleFloor);
    if (!Number.isFinite(staleMs) || staleMs < staleFloor) {
      console.warn(
        `Pigeon: keepAlive.staleMs (${ka.staleMs}) must be at least twice ` +
          `intervalMs (${intervalMs} ms), or the watchdog fires before a pong ` +
          `to its own ping can arrive; using ${staleFloor} ms.`,
      );
      staleMs = staleFloor;
    }

    let connectTimeoutMs = ka.connectTimeoutMs ?? staleMs;
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
      console.warn(
        `Pigeon: keepAlive.connectTimeoutMs must be a positive number ` +
          `(got ${ka.connectTimeoutMs}); using ${staleMs} ms.`,
      );
      connectTimeoutMs = staleMs;
    }

    return { intervalMs, staleMs, connectTimeoutMs };
  }

  private openSocket(): void {
    // Entering a new socket generation: detach the previous socket's
    // listeners and drop any stale `intentionalClose` latch. Otherwise a
    // still-closing old socket can fire a late `close` that pollutes the new
    // generation (spurious disconnect), and a leftover `intentionalClose`
    // could be consumed by an unrelated failing socket (suppressing a
    // reconnect that should happen).
    this.socketAbort?.abort();
    this.stopLiveness();
    this.intentionalClose = false;
    this.socketAbort = new AbortController();
    const { signal } = this.socketAbort;

    const url = this.options.baseUrl +
      "?address=" +
      this.options.address +
      (this.options.staticId
        ? "&initas=" + encodeURIComponent(this.options.staticId)
        : "");

    const socket = new WebSocket(url);
    // Binary frames arrive as Blobs by default, which can only be read
    // asynchronously — and out of order with respect to the text frames around
    // them. Ask for the buffer directly so the codec can run inline.
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    // A handshake has no timeout of its own. The network that just swallowed a
    // live connection swallows this one's opening bytes too, and the socket
    // then sits at CONNECTING with nothing — no `open`, no `error`, no `close`
    // — ever arriving. Healing a half-open socket without this only moves
    // where it hangs.
    //
    // The timer runs until the room's `init`, so it also ends a socket that
    // opened but never joined.
    if (this.keepAlive) {
      const { connectTimeoutMs } = this.keepAlive;
      this.connectTimer = setTimeout(() => {
        this.connectTimer = undefined;
        if (this.isConnected) return;
        if (socket.readyState === WebSocket.CONNECTING) {
          this.abandonSocket(
            socket,
            `no handshake from the room within ${connectTimeoutMs} ms`,
          );
        } else if (socket.readyState === WebSocket.OPEN) {
          this.abandonSocket(
            socket,
            `no init from the room within ${connectTimeoutMs} ms; it may be ` +
              `delivering it to an earlier connection under the same staticId`,
          );
        }
      }, connectTimeoutMs);
    }

    socket.addEventListener("open", () => {
      // A fresh socket is alive by definition; start its liveness clock here so
      // the watchdog measures silence since the connection, not since boot.
      this.lastInboundAt = Date.now();
      this.startLiveness(socket);
      this.flushQueue(socket);
    }, { signal });

    socket.addEventListener("message", (e) => {
      // Any frame at all is proof the return path is alive — the room's ping,
      // the pong to our own ping, a frame we cannot even parse. Stamp before
      // looking at it.
      this.lastInboundAt = Date.now();

      if (e.data instanceof ArrayBuffer) {
        this.receiveBinary(e.data);
        return;
      }
      if (typeof e.data !== "string") {
        // A Blob, despite `binaryType` — nothing sane to do, and the one thing
        // we must not do is run it through the text parser and call it
        // malformed. That is what flooded a venue screen's console until it
        // wedged.
        return;
      }

      let message: ReceivedMessage;
      try {
        const data = JSON.parse(e.data);
        message = parseReceiveMessage(data);
      } catch (err) {
        console.error(
          "Pigeon: dropping malformed incoming message",
          err,
          e.data,
        );
        return;
      }
      this.dispatchReceive(message);
    }, { signal });

    socket.addEventListener("close", (e) => {
      this.isConnected = false;
      this.stopLiveness();
      if (this.destroyed) return;
      this.announceDisconnect({
        code: e.code,
        reason: e.reason,
        wasClean: e.wasClean,
      });
      // Do not reconnect when the close was deliberate: either this instance
      // called `close()`, or the peer closed the connection cleanly. The
      // `intentionalClose` flag also covers a connecting socket aborted by
      // `close()`, which surfaces as `wasClean === false`.
      if (this.intentionalClose) {
        this.intentionalClose = false;
        return;
      }
      if (e.wasClean && !this.reconnectOnCleanClose) return;
      this.scheduleReconnect();
    }, { signal });

    socket.addEventListener("error", () => {
      this.isConnected = false;
    }, { signal });
  }

  // ============================================================
  // Liveness
  // ============================================================

  /** Ping the host on an interval and watch for it having gone silent. Bound to
   *  the socket instance, so a timer that outlives its connection is a no-op
   *  rather than acting on the next one. */
  private startLiveness(socket: WebSocket): void {
    this.stopHeartbeat();
    if (!this.keepAlive) return;
    const { intervalMs, staleMs } = this.keepAlive;

    this.keepaliveTimer = setInterval(() => {
      this.sendControl(socket, "ping");
    }, intervalMs);

    this.watchdogTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const silent = Date.now() - this.lastInboundAt;
      if (silent <= staleMs) return;
      // Nothing back for staleMs despite our pings: the return path is gone
      // even though this side still reads OPEN. Every send from here on goes
      // nowhere while `readyState` keeps saying otherwise.
      this.abandonSocket(
        socket,
        `no frame from the room for ${silent} ms (> ${staleMs}); the socket is half-open`,
      );
    }, intervalMs);
  }

  /**
   * Gives up on a socket that is not going to close itself.
   *
   * `close()` is the wrong tool here and quietly so: it opens a *handshake* —
   * a Close frame out, the peer's Close frame back — and the peer is precisely
   * what has gone missing. The socket parks in `CLOSING`, the `close` event
   * never fires, and the reconnect that was supposed to follow never runs. So
   * this detaches the generation, announces the disconnect itself, and
   * schedules the reconnect; the `close()` call is left in as a best-effort
   * release of the underlying resources.
   */
  private abandonSocket(socket: WebSocket, reason: string): void {
    console.warn(
      `Pigeon: ${reason} — ${
        this.autoReconnect
          ? "forcing a reconnect"
          : "closing the socket (autoReconnect is off, so nothing will reopen it)"
      }`,
    );
    this.socketAbort?.abort();
    this.stopLiveness();
    this.isConnected = false;
    try {
      socket.close();
    } catch (_) { /* best effort */ }
    this.announceDisconnect({ code: 1006, reason, wasClean: false });
    this.scheduleReconnect();
  }

  /** The single place a `pigeon:disconnect` is raised, so the close handler and
   *  the watchdog cannot drift into telling listeners different stories. */
  private announceDisconnect(detail: DisconnectReason): void {
    if (this.destroyed) return;
    this.events.dispatchEvent(
      new CustomEvent<DisconnectReason>("pigeon:disconnect", { detail }),
    );
  }

  /** Stops the keepalive ping, the watchdog and the connect timer. */
  private stopLiveness(): void {
    this.stopHeartbeat();
    this.clearConnectTimer();
  }

  /** Stops the keepalive ping and the watchdog. */
  private stopHeartbeat(): void {
    if (this.keepaliveTimer !== undefined) clearInterval(this.keepaliveTimer);
    if (this.watchdogTimer !== undefined) clearInterval(this.watchdogTimer);
    this.keepaliveTimer = undefined;
    this.watchdogTimer = undefined;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  /** The wire form of a text message. `ver` is written last so a caller's own
   *  `ver` — a relayed frame still carrying the version it arrived with, say —
   *  cannot silently misdeclare the format this client speaks. */
  private serialise<T extends MessageBody>(message: SendMessage<T>): string {
    // Spec: the client supplies `ver`, `type`, `to` and `body`; the room stamps
    // `from`, `address` and `timestamp` on relay.
    return JSON.stringify({ ...message, ver: FORMAT_VERSION });
  }

  /** Transport-level traffic: bypasses the send queue, the flow counters and
   *  the send listeners, because it is this instance talking to the room about
   *  the connection rather than the application talking to anyone. */
  private sendControl(socket: WebSocket, type: "ping" | "pong"): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(this.serialise({ to: ["host"], type, body: "" }));
    } catch (err) {
      console.warn(`Pigeon: keepalive ${type} failed`, err);
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (!this.autoReconnect) return;
    if (this.reconnectAttempts >= this.autoReconnectMaxAttempts) {
      console.warn(
        `Pigeon: reached max reconnect attempts (${this.autoReconnectMaxAttempts}); giving up`,
      );
      return;
    }
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY *
        RECONNECT_BACKOFF_FACTOR ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY,
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.destroyed) return;
      try {
        this.openSocket();
      } catch (e) {
        console.error(
          "Pigeon: failed to construct WebSocket during reconnect",
          e,
        );
        this.scheduleReconnect();
      }
    }, delay);
  }

  /** Answers a peer's ping. Never queued: a pong is worth something only on the
   *  connection that asked for it, and delivering one after a reconnect would
   *  answer a ping from a socket that no longer exists — to whichever peer
   *  holds that id by then. Throws while the socket is down, as in v0.3.0. */
  public pong(to: string[]) {
    this.sendUnqueued({ to, type: "pong", body: "" });
  }

  /** Pings a peer. Never queued, for the same reason as {@link pong}. */
  public ping(to: string[]) {
    this.sendUnqueued({ to, type: "ping", body: "" });
  }

  private sendUnqueued(message: SendMessage): void {
    const serialised = this.serialise(message);
    this.writeOrQueue(serialised, utf8ByteLength(serialised), {
      queueable: false,
      onSent: () => this.dispatchSend(message),
    });
  }

  /**
   * Sends a text message. Returns the UTF-8 byte count when the message goes
   * out (or is queued to go out), and `0` when it was dropped — so a caller
   * can meter its own contribution to room traffic.
   *
   * Without the `sendQueue` option this throws when the socket is not `OPEN`,
   * as it always has. With it, the message is held and flushed on reconnect.
   */
  public send<T extends MessageBody = MessageBody>(
    message: SendMessage<T>,
  ): number {
    const serialised = this.serialise(message);
    return this.writeOrQueue(serialised, utf8ByteLength(serialised), {
      onSent: () => this.dispatchSend(message),
    });
  }

  /**
   * Sends a binary frame: a JSON header (the same envelope as a text message,
   * plus optional `payloadMeta`) followed by raw bytes.
   *
   * Returns the frame's byte count when it goes out or is queued, `0` when it
   * was dropped. Throws if the header exceeds the format's 65535-byte cap, or
   * — without `sendQueue` — if the socket is not `OPEN`.
   */
  public sendBinary<T extends MessageBody = MessageBody>(
    message: SendBinaryMessage<T>,
    payload: Uint8Array,
  ): number {
    const frame = buildBinaryFrame({
      type: message.type,
      to: message.to,
      body: message.body,
      ...(message.payloadMeta === undefined
        ? {}
        : { payloadMeta: message.payloadMeta }),
    }, payload);
    return this.writeOrQueue(frame, frame.byteLength);
  }

  /** The one path every application frame takes out: straight onto an open
   *  socket, into the queue when there is one, or dropped and counted.
   *
   *  `onSent` fires when the frame actually reaches the socket — at flush time
   *  for a queued one — so a send listener never announces a message that is
   *  still sitting in memory, and never one that `destroy()` goes on to throw
   *  away. `queueable: false` opts a frame out of the queue entirely, for
   *  traffic that is only meaningful on the connection it was written for. */
  private writeOrQueue(
    data: string | ArrayBuffer,
    bytes: number,
    opts: { onSent?: () => void; queueable?: boolean } = {},
  ): number {
    const { onSent, queueable = true } = opts;
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(data as string & ArrayBuffer);
      this.flow.sent++;
      this.flow.sentBytes += bytes;
      if (socket.bufferedAmount > BUFFER_WARN_BYTES) {
        this.warnThrottled(
          "buffered",
          `Pigeon: ${socket.bufferedAmount} B buffered on the socket — the room ` +
            `is not keeping up with what this client is sending`,
        );
      }
      onSent?.();
      return bytes;
    }

    if (!queueable || this.queueLimit === 0) {
      throw new Error(
        `Pigeon: cannot send while socket is not OPEN (readyState=${socket?.readyState}). ` +
          `Wait for the socket to open, or check \`pigeon.isConnected\` first.` +
          (queueable
            ? ` The \`sendQueue\` option holds messages until it reconnects.`
            : ``),
      );
    }

    if (
      this.queue.length >= this.queueLimit ||
      this.queuedBytes + bytes > this.queueMaxBytes
    ) {
      this.flow.dropped++;
      this.warnThrottled(
        "dropped",
        `Pigeon: send queue full (${this.queue.length}/${this.queueLimit} messages, ` +
          `${this.queuedBytes}/${this.queueMaxBytes} B) — ${this.flow.dropped} message(s) ` +
          `dropped so far while disconnected`,
      );
      return 0;
    }

    this.queue.push({ data, bytes, onSent });
    this.queuedBytes += bytes;
    return bytes;
  }

  private flushQueue(socket: WebSocket): void {
    while (this.queue.length > 0) {
      if (socket.readyState !== WebSocket.OPEN) return;
      const frame = this.queue[0];
      try {
        socket.send(frame.data as string & ArrayBuffer);
      } catch (e) {
        // Leave it at the head of the queue; the next reconnect retries it.
        console.warn("Pigeon: flushing the send queue failed", e);
        return;
      }
      this.queue.shift();
      this.queuedBytes -= frame.bytes;
      this.flow.sent++;
      this.flow.sentBytes += frame.bytes;
      frame.onSent?.();
    }
  }

  /** One stamp per warning category: a congestion warning must not silence an
   *  unrelated drop warning for the next five seconds. */
  private warnThrottled(category: string, message: string): void {
    const now = Date.now();
    if (now - (this.lastWarnAt[category] ?? 0) < WARN_INTERVAL_MS) return;
    this.lastWarnAt[category] = now;
    console.warn(message);
  }

  /**
   * A point-in-time view of the connection, for a `/status` endpoint or a
   * dashboard. Congestion is the reason this exists: silently thinning what
   * goes out would make the client's behaviour undiagnosable, so every drop is
   * counted here rather than swallowed.
   *
   * `connected` reports having *joined* — the `init` handshake completed —
   * rather than the socket merely being open, because those come apart in
   * precisely the situation a status page is consulted about (see the
   * `staticId` note in CHANGELOG 0.4.0: a rejoin shadowed by its own ghost
   * holds an OPEN socket that never receives its `init`). `socketOpen` is the
   * transport-level answer, for telling "no connection" apart from
   * "connection, no room".
   */
  public stats(): PigeonStats {
    const open = this.socket?.readyState === WebSocket.OPEN;
    return {
      connected: this.isConnected,
      socketOpen: open,
      queued: this.queue.length,
      queuedBytes: this.queuedBytes,
      buffered: this.socket?.bufferedAmount ?? 0,
      sent: this.flow.sent,
      sentBytes: this.flow.sentBytes,
      dropped: this.flow.dropped,
      inboundAgeMs: open ? Date.now() - this.lastInboundAt : null,
      staleMs: this.keepAlive?.staleMs ?? null,
    };
  }

  /**
   * Deliberately closes the underlying WebSocket and stops auto-reconnect,
   * without tearing down listeners. Use this for an app-initiated disconnect
   * (e.g. the user logged out) where you still want the registered listeners
   * to observe the `disconnect` event. Unlike `destroy()`, the instance and
   * its listeners stay intact.
   *
   * A pending reconnect attempt, if any, is cancelled. No reconnect is
   * scheduled for the resulting close even when `autoReconnect` is enabled.
   */
  public close(): void {
    if (this.destroyed) return;
    this.intentionalClose = true;
    this.stopLiveness();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket.close();
  }

  /**
   * Re-opens the connection after a `close()` (or any non-destroyed close),
   * reusing the same options and the already-registered listeners. Use this to
   * reconnect to the same room without recreating the instance.
   *
   * No-op if the instance is destroyed, or if a socket is already `OPEN` or
   * `CONNECTING` (so calling it on a live connection cannot orphan the current
   * socket). The reconnect backoff counter is reset. Identity continuity is
   * governed by `staticId`: without it the server assigns a fresh id on rejoin.
   */
  public reopen(): void {
    if (this.destroyed) return;
    const rs = this.socket?.readyState;
    if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return;
    this.reconnectAttempts = 0;
    this.openSocket();
  }

  /**
   * Closes the socket and unregisters every listener this instance has
   * registered. Call this when the Pigeon will not be used again (e.g. on
   * route change or component unmount) to release resources promptly.
   */
  public destroy(): void {
    this.destroyed = true;
    this.stopLiveness();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socketAbort?.abort();
    this.socket.close();
    this.queue = [];
    this.queuedBytes = 0;
    this.receiveListeners.removeAll();
    this.receiveBinaryListeners.removeAll();
    this.sendListeners.removeAll();
    this.removeAllLifecycleListeners(this.connectMap, "pigeon:connect");
    this.removeAllLifecycleListeners(this.disconnectMap, "pigeon:disconnect");
    this.isConnected = false;
  }

  // ============================================================
  // Listener plumbing
  // ============================================================
  //
  // Three public listener pairs (text receive, binary receive, send) differ
  // only in which registry they write to and what they are called in a
  // warning. The branching itself — wildcard, RegExp, string, and the two
  // deprecation warnings hanging off it — lives here once, so a change to the
  // `"*"` deprecation or the RegExp/options rule cannot land in two of the
  // three. The typed overloads stay on each public method; these take over at
  // the implementation signature, where the types have already been checked.

  private addFilteredListener<M extends { type: string }>(
    registry: MessageListenerRegistry<M>,
    method: string,
    target: "*" | { type: string | RegExp },
    handler: (message: M) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (target === "*") {
      registry.addString("*", handler, options);
    } else if (target.type instanceof RegExp) {
      this.warnIfOptionsWithRegExp(method, options);
      registry.addRegExp(target.type, handler);
    } else {
      this.warnIfWildcardTypeObject(method, target.type);
      registry.addString(target.type, handler, options);
    }
  }

  private removeFilteredListener<M extends { type: string }>(
    registry: MessageListenerRegistry<M>,
    method: string,
    target: "*" | { type: string | RegExp },
    handler: unknown,
    options?: boolean | EventListenerOptions,
  ): void {
    if (target === "*") {
      registry.removeString("*", handler, options);
    } else if (target.type instanceof RegExp) {
      this.warnIfOptionsWithRegExp(method, options);
      registry.removeRegExp(handler);
    } else {
      this.warnIfWildcardTypeObject(method, target.type);
      registry.removeString(target.type, handler, options);
    }
  }

  /**
   * Fans one message out as the per-filter events its listeners subscribe to,
   * plus a bare event on `globalThis`.
   *
   * The global broadcast is v0.2.0 compatibility — `window.addEventListener(
   * "pigeon:receive", ...)` still works — and is deliberately not routed
   * through this instance's own `EventTarget`, so it cannot feed back into
   * per-instance state.
   */
  private dispatchFiltered<M extends { type: string }>(
    baseEventName: string,
    keys: readonly (keyof M & string)[],
    message: M,
  ): void {
    for (const subset of generateSubsets(keys)) {
      const filter: Record<string, string> = {};
      for (const k of subset) {
        filter[k] = message[k] as unknown as string;
      }
      this.events.dispatchEvent(
        new CustomEvent<M>(`${baseEventName}:${normalizeFilter(filter)}`, {
          detail: message,
        }),
      );
    }
    globalThis.dispatchEvent(
      new CustomEvent<M>(baseEventName, { detail: message }),
    );
  }

  // ============================================================
  // Receive listeners
  // ============================================================

  public addReceiveMessageListener<T extends MessageBody = MessageBody>(
    target: "*",
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  public addReceiveMessageListener<T extends MessageBody = MessageBody>(
    target: { type: string },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  public addReceiveMessageListener<T extends MessageBody = MessageBody>(
    target: { type: RegExp },
    handler: (message: ReceivedMessage<T>) => void,
  ): void;
  public addReceiveMessageListener<T extends MessageBody = MessageBody>(
    target: "*" | { type: string | RegExp },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.addFilteredListener(
      this.receiveListeners,
      "addReceiveMessageListener",
      target,
      handler as (message: ReceivedMessage) => void,
      options,
    );
  }

  public removeReceiveMessageListener<T extends MessageBody = MessageBody>(
    target: "*",
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  public removeReceiveMessageListener<T extends MessageBody = MessageBody>(
    target: { type: string },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  public removeReceiveMessageListener<T extends MessageBody = MessageBody>(
    target: { type: RegExp },
    handler: (message: ReceivedMessage<T>) => void,
  ): void;
  public removeReceiveMessageListener<T extends MessageBody = MessageBody>(
    target: "*" | { type: string | RegExp },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void {
    this.removeFilteredListener(
      this.receiveListeners,
      "removeReceiveMessageListener",
      target,
      handler,
      options,
    );
  }

  // ============================================================
  // Binary receive listeners
  // ============================================================

  /**
   * Subscribes to incoming *binary* frames, filtered by `type` exactly as the
   * text listeners are. Binary and text are separate streams: a handler
   * registered here never sees text, and `addReceiveMessageListener` never
   * sees binary.
   *
   * The handler receives the header envelope flattened alongside the raw
   * `payload`, which is a view onto the received buffer — copy out what you
   * intend to keep past the handler.
   */
  public addReceiveBinaryListener<T extends MessageBody = MessageBody>(
    target: "*",
    handler: (message: ReceivedBinaryMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  public addReceiveBinaryListener<T extends MessageBody = MessageBody>(
    target: { type: string },
    handler: (message: ReceivedBinaryMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  public addReceiveBinaryListener<T extends MessageBody = MessageBody>(
    target: { type: RegExp },
    handler: (message: ReceivedBinaryMessage<T>) => void,
  ): void;
  public addReceiveBinaryListener<T extends MessageBody = MessageBody>(
    target: "*" | { type: string | RegExp },
    handler: (message: ReceivedBinaryMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.addFilteredListener(
      this.receiveBinaryListeners,
      "addReceiveBinaryListener",
      target,
      handler as (message: ReceivedBinaryMessage) => void,
      options,
    );
  }

  public removeReceiveBinaryListener<T extends MessageBody = MessageBody>(
    target: "*",
    handler: (message: ReceivedBinaryMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  public removeReceiveBinaryListener<T extends MessageBody = MessageBody>(
    target: { type: string },
    handler: (message: ReceivedBinaryMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  public removeReceiveBinaryListener<T extends MessageBody = MessageBody>(
    target: { type: RegExp },
    handler: (message: ReceivedBinaryMessage<T>) => void,
  ): void;
  public removeReceiveBinaryListener<T extends MessageBody = MessageBody>(
    target: "*" | { type: string | RegExp },
    handler: (message: ReceivedBinaryMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void {
    this.removeFilteredListener(
      this.receiveBinaryListeners,
      "removeReceiveBinaryListener",
      target,
      handler,
      options,
    );
  }

  // ============================================================
  // Send listeners
  // ============================================================

  public addSendMessageListener<T extends MessageBody = MessageBody>(
    target: "*",
    handler: (message: SendMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  public addSendMessageListener<T extends MessageBody = MessageBody>(
    target: { type: string },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  public addSendMessageListener<T extends MessageBody = MessageBody>(
    target: { type: RegExp },
    handler: (message: SendMessage<T>) => void,
  ): void;
  public addSendMessageListener<T extends MessageBody = MessageBody>(
    target: "*" | { type: string | RegExp },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.addFilteredListener(
      this.sendListeners,
      "addSendMessageListener",
      target,
      handler as (message: SendMessage) => void,
      options,
    );
  }

  public removeSendMessageListener<T extends MessageBody = MessageBody>(
    target: "*",
    handler: (message: SendMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  public removeSendMessageListener<T extends MessageBody = MessageBody>(
    target: { type: string },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  public removeSendMessageListener<T extends MessageBody = MessageBody>(
    target: { type: RegExp },
    handler: (message: SendMessage<T>) => void,
  ): void;
  public removeSendMessageListener<T extends MessageBody = MessageBody>(
    target: "*" | { type: string | RegExp },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void {
    this.removeFilteredListener(
      this.sendListeners,
      "removeSendMessageListener",
      target,
      handler,
      options,
    );
  }

  // ============================================================
  // Connection lifecycle listeners
  // ============================================================

  /**
   * Subscribes to the `connect` event, fired once the `init` handshake from
   * the host completes (i.e. when `pigeon.id` and `pigeon.isConnected` become
   * available). Re-subscribing the same handler is a no-op.
   */
  public addConnectListener(
    handler: () => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.addLifecycleListener(
      this.connectMap,
      "pigeon:connect",
      handler,
      options,
    );
  }

  public removeConnectListener(
    handler: () => void,
    options?: boolean | EventListenerOptions,
  ): void {
    this.removeLifecycleListener(
      this.connectMap,
      "pigeon:connect",
      handler,
      options,
    );
  }

  /**
   * Subscribes to the `disconnect` event, fired when the underlying WebSocket
   * closes (cleanly or otherwise — including the case where the initial
   * connection attempt failed). The handler receives the close reason
   * extracted from the WebSocket `CloseEvent`.
   */
  public addDisconnectListener(
    handler: (reason: DisconnectReason) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.addLifecycleListener(
      this.disconnectMap,
      "pigeon:disconnect",
      handler,
      options,
    );
  }

  public removeDisconnectListener(
    handler: (reason: DisconnectReason) => void,
    options?: boolean | EventListenerOptions,
  ): void {
    this.removeLifecycleListener(
      this.disconnectMap,
      "pigeon:disconnect",
      handler,
      options,
    );
  }

  private addLifecycleListener<P>(
    map: Map<unknown, EventListener>,
    eventName: string,
    handler: (payload: P) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (map.has(handler)) return;
    const wrapped = (event: Event) => {
      const payload = (event as CustomEvent<P>).detail;
      queueMicrotask(() => {
        try {
          handler(payload);
        } catch (e) {
          console.error(`Error in ${eventName} handler:`, e);
        }
      });
    };
    map.set(handler, wrapped);
    this.events.addEventListener(eventName, wrapped, options);
  }

  private removeLifecycleListener(
    map: Map<unknown, EventListener>,
    eventName: string,
    handler: unknown,
    options?: boolean | EventListenerOptions,
  ): void {
    const wrapped = map.get(handler);
    if (!wrapped) return;
    this.events.removeEventListener(eventName, wrapped, options);
    map.delete(handler);
  }

  private removeAllLifecycleListeners(
    map: Map<unknown, EventListener>,
    eventName: string,
  ): void {
    for (const wrapped of map.values()) {
      this.events.removeEventListener(eventName, wrapped);
    }
    map.clear();
  }

  // ============================================================
  // Deprecated aliases
  // ============================================================

  /**
   * @deprecated since v0.3.0. Use `addReceiveMessageListener` instead.
   *
   * Reason: This alias has no `removeReceiveMessage` counterpart, so listeners
   * registered through it could not be cleaned up reliably. Use the
   * `addReceiveMessageListener` / `removeReceiveMessageListener` pair instead.
   *
   * Replacement: `addReceiveMessageListener(target, handler, options)`.
   *
   * Will be removed in v1.0.0.
   */
  public onReceiveMessage<T extends MessageBody = MessageBody>(
    target: "*" | { type: string | RegExp },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (target === "*") {
      this.addReceiveMessageListener<T>("*", handler, options);
    } else if (target.type instanceof RegExp) {
      this.addReceiveMessageListener<T>({ type: target.type }, handler);
    } else {
      this.addReceiveMessageListener<T>(
        { type: target.type },
        handler,
        options,
      );
    }
  }

  /**
   * @deprecated since v0.3.0. Use `addSendMessageListener` instead.
   *
   * Reason: This alias has no `removeSendMessage` counterpart, so listeners
   * registered through it could not be cleaned up reliably. Use the
   * `addSendMessageListener` / `removeSendMessageListener` pair instead.
   *
   * Replacement: `addSendMessageListener(target, handler, options)`.
   *
   * Will be removed in v1.0.0.
   */
  public onSendMessage<T extends MessageBody = MessageBody>(
    target: "*" | { type: string | RegExp },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (target === "*") {
      this.addSendMessageListener<T>("*", handler, options);
    } else if (target.type instanceof RegExp) {
      this.addSendMessageListener<T>({ type: target.type }, handler);
    } else {
      this.addSendMessageListener<T>({ type: target.type }, handler, options);
    }
  }

  // ============================================================
  // Internal: dispatch
  // ============================================================

  private receiveBinary(buf: ArrayBuffer): void {
    let frame: ParsedBinaryFrame;
    try {
      frame = parseBinaryFrame(buf);
    } catch (err) {
      console.error(
        "Pigeon: dropping malformed incoming binary frame",
        err,
        `${buf.byteLength} B`,
      );
      return;
    }
    const { header, payload, ver } = frame;
    this.dispatchReceiveBinary({
      type: header.type,
      to: (header.to ?? []) as string[],
      body: header.body as MessageBody,
      from: header.from,
      address: header.address,
      timestamp: header.timestamp,
      payloadMeta: header.payloadMeta,
      payload,
      ver,
    });
  }

  private dispatchReceiveBinary(message: ReceivedBinaryMessage): void {
    this.dispatchFiltered(
      "pigeon:receive-binary",
      RECEIVE_FILTERABLE_KEYS,
      message,
    );
  }

  private dispatchReceive(message: ReceivedMessage): void {
    this.dispatchFiltered("pigeon:receive", RECEIVE_FILTERABLE_KEYS, message);
  }

  private dispatchSend<T extends MessageBody>(
    message: SendMessage<T>,
  ): void {
    this.dispatchFiltered("pigeon:send", SEND_FILTERABLE_KEYS, message);
  }

  private warnIfOptionsWithRegExp(method: string, options: unknown): void {
    if (options !== undefined) {
      console.warn(
        `${method}: \`options\` are ignored when \`type\` is a RegExp. Use a string \`type\` for native EventAPI options like \`once\` or \`signal\`.`,
      );
    }
  }

  private warnIfWildcardTypeObject(method: string, type: string): void {
    if (type === "*") {
      console.warn(
        `${method}: \`{ type: "*" }\` is deprecated since v0.3.0 and will be removed in v1.0.0. Pass \`"*"\` directly as the first argument instead.`,
      );
    }
  }
}

export { Pigeon };
