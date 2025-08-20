import {
  isMessageBody,
  MessageBody,
  PigeonOptions,
  ReceivedMessage,
  SendMessage,
} from "./types.ts";

class Pigeon {
  public id: string | undefined;
  public isConnected: boolean;
  public socket: WebSocket;

  constructor(pigeonOptions: PigeonOptions) {
    try {
      this.socket = new WebSocket(
        pigeonOptions.baseUrl + "?address=" + pigeonOptions.address +
          (
            pigeonOptions.staticId
              ? "&initas=" + encodeURIComponent(pigeonOptions.staticId)
              : ""
          ),
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

      this.onReceiveMessage<{
        id: string;
        clients: string[];
      }>({ type: "init" }, (message) => {
        if (message.from === "host") {
          this.id = message.body.id;
          this.isConnected = true;
        }
      });

      this.onReceiveMessage({ type: "ping" }, (message) => {
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

  public onSendMessage<T extends MessageBody = MessageBody>(
    target: {
      type: string | RegExp;
    },
    handler: (message: SendMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ) {
    let type: string | RegExp = "*";
    if ("type" in target) {
      type = target.type;
    }
    addEventListener("pigeon:send", (event) => {
      const e = event as CustomEvent<SendMessage<T>>;
      try {
        const message = e.detail;
        let isTargetMatch = false;
        if (type instanceof RegExp) {
          isTargetMatch = type.test(message.type);
        } else {
          if ("*" === type) {
            isTargetMatch = true;
          }
          if (message.type === type) {
            isTargetMatch = true;
          }
        }
        if (isTargetMatch) {
          queueMicrotask(() => {
            handler(message);
          });
        }
      } catch (e) {
        throw new Error(
          "Failed to parse Pigeon Message in parse message.",
          {
            cause: e,
          },
        );
      }
    }, options);
  }

  public onReceiveMessage<T extends MessageBody = MessageBody>(
    target: {
      type: string | RegExp;
    },
    handler: (message: ReceivedMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ) {
    let type: string | RegExp = "*";
    if ("type" in target) {
      type = target.type;
    }
    addEventListener("pigeon:receive", (event) => {
      const e = event as CustomEvent<ReceivedMessage<T>>;
      try {
        const message = e.detail;
        let isTargetMatch = false;
        if (type instanceof RegExp) {
          isTargetMatch = type.test(message.type);
        } else {
          if ("*" === type) {
            isTargetMatch = true;
          }
          if (message.type === type) {
            isTargetMatch = true;
          }
        }
        if (isTargetMatch) {
          queueMicrotask(() => {
            handler(message);
          });
        }
      } catch (e) {
        throw new Error(
          "Failed to parse Pigeon Message in parse message.",
          {
            cause: e,
          },
        );
      }
    }, options);
  }

  private parseReceiveMessage<T extends MessageBody>(
    message: unknown,
  ): ReceivedMessage<T> {
    const error = new Error(
      `Uncaught SyntaxError: ${String(message)} is not valid Message`,
    );
    if (
      typeof message !== "object" ||
      message === null
    ) throw error;
    if (
      !("address" in message) ||
      typeof message.address !== "string"
    ) throw error;
    if (
      !("from" in message) ||
      typeof message.from !== "string"
    ) throw error;
    if (
      !("timestamp" in message) ||
      typeof message.timestamp !== "number"
    ) throw error;
    if (
      !("to" in message) ||
      !Array.isArray(message.to)
    ) throw error;
    if (!message.to.every((to) => typeof to === "string")) throw error;
    if (
      !("type" in message) ||
      typeof message.type !== "string"
    ) throw error;
    if (
      !("body" in message) ||
      !isMessageBody(message.body)
    ) throw error;

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
