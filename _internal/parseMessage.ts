import {
  isMessageBody,
  type MessageBody,
  type ReceivedMessage,
} from "../types.ts";

export const parseReceiveMessage = <T extends MessageBody>(
  message: unknown,
): ReceivedMessage<T> => {
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
};
