import { Pigeon } from "./mod.ts";

// Pigeon builds its socket with a bare `new WebSocket(url)`, so a stand-in on
// the global is all it takes to drive it. Only the surface Pigeon touches is
// implemented; EventTarget supplies `addEventListener` and its `signal` option.
class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeWebSocket.OPEN;
  binaryType = "blob";
  readonly sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

/** Swap in the fake, run the body, and always put the real one back. */
function withFakeSocket(
  run: (pigeon: Pigeon, socket: FakeWebSocket) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const realWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    let pigeon: Pigeon | undefined;
    try {
      pigeon = new Pigeon({
        baseUrl: "wss://example.test/pigeon",
        address: "a",
      });
      await run(pigeon, pigeon.socket as unknown as FakeWebSocket);
    } finally {
      pigeon?.destroy();
      globalThis.WebSocket = realWebSocket;
    }
  };
}

/** Handlers are deferred with `queueMicrotask`; let the task queue drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Run `body` with `console.error` captured rather than printed. */
async function recordingErrors(
  body: () => Promise<void>,
): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void calls.push(args);
  try {
    await body();
  } finally {
    console.error = realError;
  }
  return calls;
}

const textFrame = (type: string) =>
  JSON.stringify({
    address: "a",
    from: "someone",
    to: ["all"],
    timestamp: 0,
    type,
    body: {},
  });

Deno.test(
  "the socket reads binary as ArrayBuffer, not Blob",
  withFakeSocket((_pigeon, socket) => {
    if (socket.binaryType !== "arraybuffer") {
      throw new Error(`binaryType is ${socket.binaryType}, want arraybuffer`);
    }
    return Promise.resolve();
  }),
);

Deno.test(
  "a binary frame reaches its listener and is not treated as malformed",
  withFakeSocket(async (pigeon, socket) => {
    const received: ArrayBuffer[] = [];
    pigeon.addReceiveBinaryListener((data) => received.push(data));

    const payload = new Uint8Array([1, 2, 3, 4]);
    const errors = await recordingErrors(async () => {
      socket.dispatchEvent(
        new MessageEvent("message", { data: payload.buffer }),
      );
      await settle();
    });

    if (errors.length !== 0) {
      throw new Error(
        `console.error called ${errors.length}x: ${errors[0]?.[0]}`,
      );
    }
    if (received.length !== 1) {
      throw new Error(`listener fired ${received.length}x, want 1`);
    }
    const got = new Uint8Array(received[0]);
    if (got.length !== 4 || got[0] !== 1 || got[3] !== 4) {
      throw new Error(`payload mangled: ${got}`);
    }
  }),
);

Deno.test(
  "a binary frame nobody listens for is dropped in silence",
  withFakeSocket(async (_pigeon, socket) => {
    const errors = await recordingErrors(async () => {
      socket.dispatchEvent(
        new MessageEvent("message", { data: new Uint8Array([0]).buffer }),
      );
      await settle();
    });
    if (errors.length !== 0) {
      throw new Error(
        `console.error called ${errors.length}x: ${errors[0]?.[0]}`,
      );
    }
  }),
);

Deno.test(
  "text frames still parse, and a malformed one still says so",
  withFakeSocket(async (pigeon, socket) => {
    const seen: string[] = [];
    pigeon.addReceiveMessageListener("*", (m) => seen.push(m.type));

    const errors = await recordingErrors(async () => {
      socket.dispatchEvent(
        new MessageEvent("message", { data: textFrame("hello") }),
      );
      socket.dispatchEvent(new MessageEvent("message", { data: "{ not json" }));
      await settle();
    });

    if (!seen.includes("hello")) {
      throw new Error(
        `text frame did not dispatch; saw ${JSON.stringify(seen)}`,
      );
    }
    if (errors.length !== 1) {
      throw new Error(
        `want exactly one malformed-message error, got ${errors.length}`,
      );
    }
  }),
);

Deno.test(
  "removeReceiveBinaryListener stops delivery",
  withFakeSocket(async (pigeon, socket) => {
    let calls = 0;
    const handler = () => void calls++;
    pigeon.addReceiveBinaryListener(handler);
    pigeon.removeReceiveBinaryListener(handler);

    socket.dispatchEvent(
      new MessageEvent("message", { data: new Uint8Array([0]).buffer }),
    );
    await settle();

    if (calls !== 0) throw new Error(`listener fired ${calls}x after removal`);
  }),
);
