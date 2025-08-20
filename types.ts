export type PigeonOptions = {
  baseUrl: string;
  address: string;
  staticId?: string;
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
