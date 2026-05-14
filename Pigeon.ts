import {
  isMessageBody,
  type MessageBody,
  type PigeonOptions,
  type ReceivedMessage,
  type SendMessage,
} from "./types.ts";

type ListenerKey = string | RegExp;
type ListenerMap = Map<unknown, Map<ListenerKey, EventListener>>;

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
        dispatchEvent(
          new CustomEvent<ReceivedMessage>("pigeon:receive", {
            detail: message,
          }),
        );
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
    dispatchEvent(
      new CustomEvent<SendMessage<T>>("pigeon:send", { detail: message }),
    );
  }

  public addSendMessageListener<T extends MessageBody = MessageBody>(
    target: { type: string | RegExp },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.addMessageListener<SendMessage<T>>(
      "pigeon:send",
      this.sendListenerMap,
      target,
      handler,
      options,
    );
  }

  public removeSendMessageListener<T extends MessageBody = MessageBody>(
    target: { type: string | RegExp },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void {
    this.removeMessageListener(
      "pigeon:send",
      this.sendListenerMap,
      target,
      handler,
      options,
    );
  }

  public addReceiveMessageListener<T extends MessageBody = MessageBody>(
    target: { type: string | RegExp },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.addMessageListener<ReceivedMessage<T>>(
      "pigeon:receive",
      this.receiveListenerMap,
      target,
      handler,
      options,
    );
  }

  public removeReceiveMessageListener<T extends MessageBody = MessageBody>(
    target: { type: string | RegExp },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | EventListenerOptions,
  ): void {
    this.removeMessageListener(
      "pigeon:receive",
      this.receiveListenerMap,
      target,
      handler,
      options,
    );
  }

  /** @deprecated Use `addReceiveMessageListener` instead. */
  public onReceiveMessage<T extends MessageBody = MessageBody>(
    target: {
      type: string | RegExp;
    },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.addReceiveMessageListener(target, handler, options);
  }

  /** @deprecated Use `addSendMessageListener` instead. */
  public onSendMessage<T extends MessageBody = MessageBody>(
    target: { type: string | RegExp },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.addSendMessageListener(target, handler, options);
  }

  private addMessageListener<M extends { type: string }>(
    eventName: "pigeon:receive" | "pigeon:send",
    map: ListenerMap,
    target: { type: string | RegExp },
    handler: (message: M) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const type: string | RegExp = target.type ?? "*";

    let typeMap = map.get(handler);
    if (!typeMap) {
      typeMap = new Map();
      map.set(handler, typeMap);
    }
    // Already registered for the same (handler, type) pair: ignore (matches addEventListener semantics).
    if (typeMap.has(type)) return;

    const listener = (event: Event) => {
      const message = (event as CustomEvent<M>).detail;
      let isTargetMatch = false;
      if (type instanceof RegExp) {
        isTargetMatch = type.test(message.type);
      } else if (type === "*" || message.type === type) {
        isTargetMatch = true;
      }
      if (isTargetMatch) {
        queueMicrotask(() => {
          try {
            handler(message);
          } catch (e) {
            console.error(`Error in ${eventName} handler:`, e);
          }
        });
      }
    };

    typeMap.set(type, listener);
    addEventListener(eventName, listener, options);
  }

  private removeMessageListener(
    eventName: "pigeon:receive" | "pigeon:send",
    map: ListenerMap,
    target: {
      type: string | RegExp;
    },
    handler: unknown,
    options?: boolean | EventListenerOptions,
  ): void {
    const type: string | RegExp = target.type ?? "*";

    const typeMap = map.get(handler);
    if (!typeMap) return;

    const listener = typeMap.get(type);
    if (!listener) return;

    removeEventListener(eventName, listener, options);
    typeMap.delete(type);
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
