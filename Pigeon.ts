import {
  isMessageBody,
  type MessageBody,
  type PigeonOptions,
  type ReceivedMessage,
  type SendMessage,
} from "./types.ts";

// Keys of a message that can be used as filter conditions.
// Adding a key here automatically expands the dispatched event combinations.
const RECEIVE_FILTERABLE_KEYS = ["type"] as const;
const SEND_FILTERABLE_KEYS = ["type"] as const;

const normalizeFilter = (filter: Record<string, string>): string => {
  const sorted: Record<string, string> = {};
  Object.keys(filter).sort().forEach((k) => {
    sorted[k] = filter[k];
  });
  return JSON.stringify(sorted);
};

const generateSubsets = <T>(items: readonly T[]): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < (1 << items.length); i++) {
    const subset: T[] = [];
    items.forEach((item, idx) => {
      if (i & (1 << idx)) subset.push(item);
    });
    result.push(subset);
  }
  return result;
};

type ListenerMap = Map<unknown, Map<string, EventListener>>;

class Pigeon {
  public id: string | undefined;
  public isConnected: boolean;
  public socket: WebSocket;

  private receiveListenerMap: ListenerMap = new Map();
  private sendListenerMap: ListenerMap = new Map();

  constructor(pigeonOptions: PigeonOptions) {
    try {
      this.socket = new WebSocket(
        pigeonOptions.baseUrl +
          "?address=" +
          pigeonOptions.address +
          (pigeonOptions.staticId
            ? "&initas=" + encodeURIComponent(pigeonOptions.staticId)
            : ""),
      );

      this.isConnected = false;

      this.socket.addEventListener("message", (e) => {
        const data = JSON.parse(e.data);
        const message = this.parseReceiveMessage(data);
        this.dispatchReceive(message);
      });

      this.addReceiveMessageListener<{
        id: string;
        clients: string[];
      }>({ type: "init" }, (message) => {
        if (message.from === "host") {
          this.id = message.body.id;
          this.isConnected = true;
        }
      });

      this.addReceiveMessageListener({ type: "ping" }, (message) => {
        this.pong([message.from]);
      });
    } catch (e) {
      if (e instanceof Error) {
        throw e;
      }
      throw new Error("unknown error");
    }
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
    this.socket.send(JSON.stringify(message));
    this.dispatchSend(message);
  }

  // ============================================================
  // Receive listeners
  // ============================================================

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
    target: { type: string | RegExp },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (target.type instanceof RegExp) {
      this.warnIfOptionsWithRegExp("addReceiveMessageListener", options);
      this.addRegExpListener<ReceivedMessage<T>>(
        "pigeon:receive",
        this.receiveListenerMap,
        target.type,
        handler,
      );
    } else {
      this.addStringListener<ReceivedMessage<T>>(
        "pigeon:receive",
        this.receiveListenerMap,
        target.type,
        handler,
        options,
      );
    }
  }

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
    target: { type: string | RegExp },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void {
    if (target.type instanceof RegExp) {
      this.warnIfOptionsWithRegExp("removeReceiveMessageListener", options);
      this.removeRegExpListener(
        "pigeon:receive",
        this.receiveListenerMap,
        handler,
      );
    } else {
      this.removeStringListener(
        "pigeon:receive",
        this.receiveListenerMap,
        target.type,
        handler,
        options,
      );
    }
  }

  // ============================================================
  // Send listeners
  // ============================================================

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
    target: { type: string | RegExp },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (target.type instanceof RegExp) {
      this.warnIfOptionsWithRegExp("addSendMessageListener", options);
      this.addRegExpListener<SendMessage<T>>(
        "pigeon:send",
        this.sendListenerMap,
        target.type,
        handler,
      );
    } else {
      this.addStringListener<SendMessage<T>>(
        "pigeon:send",
        this.sendListenerMap,
        target.type,
        handler,
        options,
      );
    }
  }

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
    target: { type: string | RegExp },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void {
    if (target.type instanceof RegExp) {
      this.warnIfOptionsWithRegExp("removeSendMessageListener", options);
      this.removeRegExpListener(
        "pigeon:send",
        this.sendListenerMap,
        handler,
      );
    } else {
      this.removeStringListener(
        "pigeon:send",
        this.sendListenerMap,
        target.type,
        handler,
        options,
      );
    }
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
    target: { type: string | RegExp },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (target.type instanceof RegExp) {
      this.addReceiveMessageListener({ type: target.type }, handler);
    } else {
      this.addReceiveMessageListener({ type: target.type }, handler, options);
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
    target: { type: string | RegExp },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (target.type instanceof RegExp) {
      this.addSendMessageListener({ type: target.type }, handler);
    } else {
      this.addSendMessageListener({ type: target.type }, handler, options);
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
      dispatchEvent(
        new CustomEvent<ReceivedMessage>(eventName, { detail: message }),
      );
    }
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
      dispatchEvent(
        new CustomEvent<SendMessage<T>>(eventName, { detail: message }),
      );
    }
  }

  // ============================================================
  // Internal: listener registration
  // ============================================================

  private addStringListener<M>(
    baseEventName: "pigeon:receive" | "pigeon:send",
    map: ListenerMap,
    type: string,
    handler: (message: M) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    // Wildcard "*" subscribes to the empty filter (i.e. every message).
    const filter: Record<string, string> = type === "*" ? {} : { type };
    const eventName = `${baseEventName}:${normalizeFilter(filter)}`;

    let typeMap = map.get(handler);
    if (!typeMap) {
      typeMap = new Map();
      map.set(handler, typeMap);
    }
    // Already registered for the same (handler, eventName) pair: ignore (matches addEventListener semantics).
    if (typeMap.has(eventName)) return;

    const wrapped = (event: Event) => {
      const message = (event as CustomEvent<M>).detail;
      queueMicrotask(() => {
        try {
          handler(message);
        } catch (e) {
          console.error(`Error in ${baseEventName} handler:`, e);
        }
      });
    };
    typeMap.set(eventName, wrapped);
    addEventListener(eventName, wrapped, options);
  }

  private addRegExpListener<M extends { type: string }>(
    baseEventName: "pigeon:receive" | "pigeon:send",
    map: ListenerMap,
    regex: RegExp,
    handler: (message: M) => void,
  ): void {
    // RegExp filters subscribe to the all-messages event and filter internally.
    // Native EventAPI options (once / signal / etc) are intentionally not
    // supported here, because internal filtering would consume those options
    // on filtered-out messages. Use a string `type` if option support is needed.
    const eventName = `${baseEventName}:{}`;

    let typeMap = map.get(handler);
    if (!typeMap) {
      typeMap = new Map();
      map.set(handler, typeMap);
    }
    if (typeMap.has(eventName)) return;

    const wrapped = (event: Event) => {
      const message = (event as CustomEvent<M>).detail;
      if (regex.test(message.type)) {
        queueMicrotask(() => {
          try {
            handler(message);
          } catch (e) {
            console.error(`Error in ${baseEventName} handler:`, e);
          }
        });
      }
    };
    typeMap.set(eventName, wrapped);
    addEventListener(eventName, wrapped);
  }

  private removeStringListener(
    baseEventName: "pigeon:receive" | "pigeon:send",
    map: ListenerMap,
    type: string,
    handler: unknown,
    options?: boolean | EventListenerOptions,
  ): void {
    const filter: Record<string, string> = type === "*" ? {} : { type };
    const eventName = `${baseEventName}:${normalizeFilter(filter)}`;
    this.removeListenerByEventName(map, eventName, handler, options);
  }

  private removeRegExpListener(
    baseEventName: "pigeon:receive" | "pigeon:send",
    map: ListenerMap,
    handler: unknown,
  ): void {
    const eventName = `${baseEventName}:{}`;
    this.removeListenerByEventName(map, eventName, handler);
  }

  private warnIfOptionsWithRegExp(method: string, options: unknown): void {
    if (options !== undefined) {
      console.warn(
        `${method}: \`options\` are ignored when \`type\` is a RegExp. Use a string \`type\` for native EventAPI options like \`once\` or \`signal\`.`,
      );
    }
  }

  private removeListenerByEventName(
    map: ListenerMap,
    eventName: string,
    handler: unknown,
    options?: boolean | EventListenerOptions,
  ): void {
    const typeMap = map.get(handler);
    if (!typeMap) return;

    const wrapped = typeMap.get(eventName);
    if (!wrapped) return;

    removeEventListener(eventName, wrapped, options);
    typeMap.delete(eventName);
    if (typeMap.size === 0) {
      map.delete(handler);
    }
  }

  private parseReceiveMessage<T extends MessageBody>(
    message: unknown,
  ): ReceivedMessage<T> {
    const error = new Error(
      `Uncaught SyntaxError: ${String(message)} is not valid Message`,
    );
    if (typeof message !== "object" || message === null) throw error;
    if (!("address" in message) || typeof message.address !== "string") {
      throw error;
    }
    if (!("from" in message) || typeof message.from !== "string") throw error;
    if (!("timestamp" in message) || typeof message.timestamp !== "number") {
      throw error;
    }
    if (!("to" in message) || !Array.isArray(message.to)) throw error;
    if (!message.to.every((to) => typeof to === "string")) throw error;
    if (!("type" in message) || typeof message.type !== "string") throw error;
    if (!("body" in message) || !isMessageBody(message.body)) throw error;

    return {
      address: message.address,
      from: message.from,
      to: message.to,
      timestamp: message.timestamp,
      type: message.type,
      body: message.body as unknown as T,
    };
  }
}

export { Pigeon };
