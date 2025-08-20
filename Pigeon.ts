import {
  isMessageBody,
  MessageBody,
  PigeonOptions,
  RecievedMessage,
  SendMessage,
} from "./types.ts";

class Pigeon {
  public id: string | undefined;
  public isConnected: boolean;
  public socket: WebSocket;

  constructor(pigeonOptiuons: PigeonOptions) {
    try {
      this.socket = new WebSocket(
        pigeonOptiuons.baseUrl + "?address=" + pigeonOptiuons.address +
          (
            pigeonOptiuons.staticId
              ? "&initas=" + encodeURIComponent(pigeonOptiuons.staticId)
              : ""
          ),
      );

      this.isConnected = false;

      this.socket.addEventListener("message", (e) => {
        const data = JSON.parse(e.data);
        const message = this.parseRecieveMessage(data);
        dispatchEvent(
          new CustomEvent<RecievedMessage>("pigeon:receive", {
            detail: message,
          }),
        );
      });

      this.onRecieveMessage<{
        id: string;
        clients: string[];
      }>({ type: "init" }, (message) => {
        if (message.from === "host") {
          this.id = message.body.id;
          this.isConnected = true;
        }
      });

      this.onRecieveMessage({ type: "ping" }, (message) => {
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

  public onRecieveMessage<T extends MessageBody = MessageBody>(
    target: {
      type: string | RegExp;
    },
    handler: (message: RecievedMessage<T>) => void,
    options?: boolean | AddEventListenerOptions,
  ) {
    let type: string | RegExp = "*";
    if ("type" in target) {
      type = target.type;
    }
    addEventListener("pigeon:receive", (event) => {
      const e = event as CustomEvent<RecievedMessage<T>>;
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

  private parseRecieveMessage<T extends MessageBody>(
    message: unknown,
  ): RecievedMessage<T> {
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
