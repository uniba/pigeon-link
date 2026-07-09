import type {
  DisconnectReason,
  MessageBody,
  PigeonOptions,
  ReceivedMessage,
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

const RECONNECT_INITIAL_DELAY = 500;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_BACKOFF_FACTOR = 2;

class Pigeon {
  public id: string | undefined;
  public isConnected: boolean = false;
  public socket!: WebSocket;

  private options: PigeonOptions;
  private autoReconnect: boolean;
  private autoReconnectMaxAttempts: number;
  private destroyed = false;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private socketAbort: AbortController | undefined;

  private events = new EventTarget();
  private receiveListeners = new MessageListenerRegistry<ReceivedMessage>(
    "pigeon:receive",
    this.events,
  );
  private sendListeners = new MessageListenerRegistry<SendMessage>(
    "pigeon:send",
    this.events,
  );
  private connectMap: Map<unknown, EventListener> = new Map();
  private disconnectMap: Map<unknown, EventListener> = new Map();
  private receiveBinaryMap: Map<unknown, EventListener> = new Map();

  constructor(pigeonOptions: PigeonOptions) {
    console.log("pigeon link v0.3.0");
    this.options = pigeonOptions;
    const ar = pigeonOptions.autoReconnect;
    if (!ar) {
      this.autoReconnect = false;
      this.autoReconnectMaxAttempts = 0;
    } else {
      this.autoReconnect = true;
      this.autoReconnectMaxAttempts =
        (ar === true ? undefined : ar.maxAttempts) ?? Infinity;
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
        this.events.dispatchEvent(new CustomEvent("pigeon:connect"));
      }
    });

    this.addReceiveMessageListener({ type: "ping" }, (message) => {
      this.pong([message.from]);
    });
  }

  private openSocket(): void {
    // Entering a new socket generation: detach the previous socket's
    // listeners and drop any stale `intentionalClose` latch. Otherwise a
    // still-closing old socket can fire a late `close` that pollutes the new
    // generation (spurious disconnect), and a leftover `intentionalClose`
    // could be consumed by an unrelated failing socket (suppressing a
    // reconnect that should happen).
    this.socketAbort?.abort();
    this.intentionalClose = false;
    this.socketAbort = new AbortController();
    const { signal } = this.socketAbort;

    const url = this.options.baseUrl +
      "?address=" +
      this.options.address +
      (this.options.staticId
        ? "&initas=" + encodeURIComponent(this.options.staticId)
        : "");

    this.socket = new WebSocket(url);
    // A Blob would have to be read asynchronously before a consumer could even
    // look at the frame's header. An ArrayBuffer can be read in place.
    this.socket.binaryType = "arraybuffer";

    this.socket.addEventListener("message", (e) => {
      // Pigeon Room sends binary frames on the same socket as text ones. They
      // are not JSON, and until now they fell through to the malformed-message
      // path below: one `console.error` per frame, with the frame itself as an
      // argument. A room carrying a depth-camera stream fills the console with
      // hundreds of retained buffers a second.
      if (typeof e.data !== "string") {
        this.dispatchReceiveBinary(e.data as ArrayBuffer);
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

    this.socket.addEventListener("close", (e) => {
      this.isConnected = false;
      if (this.destroyed) return;
      this.events.dispatchEvent(
        new CustomEvent<DisconnectReason>("pigeon:disconnect", {
          detail: {
            code: e.code,
            reason: e.reason,
            wasClean: e.wasClean,
          },
        }),
      );
      // Do not reconnect when the close was deliberate: either this instance
      // called `close()`, or the peer closed the connection cleanly. The
      // `intentionalClose` flag also covers a connecting socket aborted by
      // `close()`, which surfaces as `wasClean === false`.
      if (this.intentionalClose) {
        this.intentionalClose = false;
        return;
      }
      if (e.wasClean) return;
      this.scheduleReconnect();
    }, { signal });

    this.socket.addEventListener("error", () => {
      this.isConnected = false;
    }, { signal });
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

  public pong(to: string[]) {
    this.send({
      to,
      type: "pong",
      body: "",
    });
  }

  public ping(to: string[]) {
    this.send({
      to,
      type: "ping",
      body: "",
    });
  }

  public send<T extends MessageBody = MessageBody>(
    message: SendMessage<T>,
  ): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        `Pigeon: cannot send while socket is not OPEN (readyState=${this.socket.readyState}). Wait for the socket to open or check \`pigeon.isConnected\` before calling \`send\`.`,
      );
    }
    this.socket.send(JSON.stringify(message));
    this.dispatchSend(message);
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
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socketAbort?.abort();
    this.socket.close();
    this.receiveListeners.removeAll();
    this.sendListeners.removeAll();
    this.removeAllLifecycleListeners(this.connectMap, "pigeon:connect");
    this.removeAllLifecycleListeners(this.disconnectMap, "pigeon:disconnect");
    this.removeAllLifecycleListeners(
      this.receiveBinaryMap,
      "pigeon:receive-binary",
    );
    this.isConnected = false;
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
    if (target === "*") {
      this.receiveListeners.addString(
        "*",
        handler as (message: ReceivedMessage) => void,
        options,
      );
    } else if (target.type instanceof RegExp) {
      this.warnIfOptionsWithRegExp("addReceiveMessageListener", options);
      this.receiveListeners.addRegExp(
        target.type,
        handler as (message: ReceivedMessage) => void,
      );
    } else {
      this.warnIfWildcardTypeObject("addReceiveMessageListener", target.type);
      this.receiveListeners.addString(
        target.type,
        handler as (message: ReceivedMessage) => void,
        options,
      );
    }
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
    if (target === "*") {
      this.receiveListeners.removeString("*", handler, options);
    } else if (target.type instanceof RegExp) {
      this.warnIfOptionsWithRegExp("removeReceiveMessageListener", options);
      this.receiveListeners.removeRegExp(handler);
    } else {
      this.warnIfWildcardTypeObject(
        "removeReceiveMessageListener",
        target.type,
      );
      this.receiveListeners.removeString(target.type, handler, options);
    }
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
    if (target === "*") {
      this.sendListeners.addString(
        "*",
        handler as (message: SendMessage) => void,
        options,
      );
    } else if (target.type instanceof RegExp) {
      this.warnIfOptionsWithRegExp("addSendMessageListener", options);
      this.sendListeners.addRegExp(
        target.type,
        handler as (message: SendMessage) => void,
      );
    } else {
      this.warnIfWildcardTypeObject("addSendMessageListener", target.type);
      this.sendListeners.addString(
        target.type,
        handler as (message: SendMessage) => void,
        options,
      );
    }
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
    if (target === "*") {
      this.sendListeners.removeString("*", handler, options);
    } else if (target.type instanceof RegExp) {
      this.warnIfOptionsWithRegExp("removeSendMessageListener", options);
      this.sendListeners.removeRegExp(handler);
    } else {
      this.warnIfWildcardTypeObject("removeSendMessageListener", target.type);
      this.sendListeners.removeString(target.type, handler, options);
    }
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

  /**
   * Subscribes to binary frames. Pigeon Room delivers them on the same socket
   * as text messages; they carry no JSON, so they are handed over as the
   * `ArrayBuffer` they arrived as, for the application to decode.
   *
   * A room with no binary traffic never fires this, and an application that
   * does not subscribe pays nothing: an unheard frame is dropped where it
   * arrives.
   */
  public addReceiveBinaryListener(
    handler: (data: ArrayBuffer) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.addLifecycleListener(
      this.receiveBinaryMap,
      "pigeon:receive-binary",
      handler,
      options,
    );
  }

  public removeReceiveBinaryListener(
    handler: (data: ArrayBuffer) => void,
    options?: boolean | EventListenerOptions,
  ): void {
    this.removeLifecycleListener(
      this.receiveBinaryMap,
      "pigeon:receive-binary",
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

  private dispatchReceive(message: ReceivedMessage): void {
    for (const subset of generateSubsets(RECEIVE_FILTERABLE_KEYS)) {
      const filter: Record<string, string> = {};
      for (const k of subset) {
        filter[k] = message[k];
      }
      const eventName = `pigeon:receive:${normalizeFilter(filter)}`;
      this.events.dispatchEvent(
        new CustomEvent<ReceivedMessage>(eventName, { detail: message }),
      );
    }
    // Also broadcast the bare event on globalThis for v0.2.0 compatibility
    // (e.g. `window.addEventListener("pigeon:receive", ...)`). Internal
    // handlers live on `this.events`, so this broadcast does not feed back
    // into per-instance state.
    globalThis.dispatchEvent(
      new CustomEvent<ReceivedMessage>("pigeon:receive", { detail: message }),
    );
  }

  private dispatchReceiveBinary(data: ArrayBuffer): void {
    this.events.dispatchEvent(
      new CustomEvent<ArrayBuffer>("pigeon:receive-binary", { detail: data }),
    );
    // Mirrors the bare `pigeon:receive` broadcast above, so a page that reaches
    // for the global event surface finds binary there too.
    globalThis.dispatchEvent(
      new CustomEvent<ArrayBuffer>("pigeon:receive-binary", { detail: data }),
    );
  }

  private dispatchSend<T extends MessageBody>(
    message: SendMessage<T>,
  ): void {
    for (const subset of generateSubsets(SEND_FILTERABLE_KEYS)) {
      const filter: Record<string, string> = {};
      for (const k of subset) {
        filter[k] = message[k];
      }
      const eventName = `pigeon:send:${normalizeFilter(filter)}`;
      this.events.dispatchEvent(
        new CustomEvent<SendMessage<T>>(eventName, { detail: message }),
      );
    }
    globalThis.dispatchEvent(
      new CustomEvent<SendMessage<T>>("pigeon:send", { detail: message }),
    );
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
