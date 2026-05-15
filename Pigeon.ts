import type {
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

class Pigeon {
  public id: string | undefined;
  public isConnected: boolean;
  public socket: WebSocket;

  private events = new EventTarget();
  private receiveListeners = new MessageListenerRegistry<ReceivedMessage>(
    "pigeon:receive",
    this.events,
  );
  private sendListeners = new MessageListenerRegistry<SendMessage>(
    "pigeon:send",
    this.events,
  );

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
      });

      this.socket.addEventListener("close", () => {
        this.isConnected = false;
      });

      this.socket.addEventListener("error", () => {
        this.isConnected = false;
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
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        `Pigeon: cannot send while socket is not OPEN (readyState=${this.socket.readyState}). Wait for the socket to open or check \`pigeon.isConnected\` before calling \`send\`.`,
      );
    }
    this.socket.send(JSON.stringify(message));
    this.dispatchSend(message);
  }

  /**
   * Closes the socket and unregisters every listener this instance has
   * registered. Call this when the Pigeon will not be used again (e.g. on
   * route change or component unmount) to release resources promptly.
   */
  public destroy(): void {
    this.socket.close();
    this.receiveListeners.removeAll();
    this.sendListeners.removeAll();
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
