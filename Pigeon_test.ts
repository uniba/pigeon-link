// Integration tests, against a real `@circuitlab/pigeon-room`.
//
// A mock room would be the wrong instrument here. Most of what these cover is
// not "does the code branch" but "does this survive a network that misbehaves"
// — a half-open path, a swallowed handshake, a room that reaps quiet peers —
// and the answers only mean anything against the room we actually talk to.

import { PigeonRoom } from "@circuitlab/pigeon-room";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { Pigeon } from "./mod.ts";
import { utf8ByteLength } from "./_internal/utf8.ts";

const ADDRESS = "test-room";

// PigeonRoom starts a reaper interval in its constructor that it never clears,
// so the leak sanitiser fires on every test that stands a room up.
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

function startRoom() {
  const room = new PigeonRoom();
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname === "/pigeon") return room.handleReqest(req);
    return new Response("not found", { status: 404 });
  });
  const port = (server.addr as Deno.NetAddr).port;
  return { room, server, port, url: `ws://localhost:${port}/pigeon` };
}

const until = async (cond: () => boolean, ms = 5000, label = "condition") => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const connected = (p: Pigeon) => until(() => p.isConnected, 5000, "connect");

/** Captures console.warn/error for the duration of `fn`. */
async function captureConsole(
  fn: () => Promise<void> | void,
): Promise<{ warns: string[]; errors: string[] }> {
  const warns: string[] = [];
  const errors: string[] = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
  return { warns, errors };
}

// -------------------------------------------------------------- byte metering

Deno.test("utf8ByteLength matches TextEncoder", () => {
  const enc = new TextEncoder();
  for (
    const s of [
      "",
      "ascii only",
      "こんにちは",
      "日本語とasciiの混在",
      "éèê", // 2-byte
      "ࠀ￿", // 3-byte
      "🕊️🍊👨‍👩‍👧", // surrogate pairs + ZWJ
      "lone high \ud800 surrogate",
      "lone low \udc00 surrogate",
      "trailing high surrogate \ud800",
    ]
  ) {
    assertEquals(utf8ByteLength(s), enc.encode(s).length, JSON.stringify(s));
  }
});

test("byte accounting is UTF-8, not UTF-16 code units", async () => {
  const { server, url } = startRoom();
  const a = new Pigeon({ baseUrl: url, address: ADDRESS, staticId: "a" });
  await connected(a);

  // 5 chars, 15 UTF-8 bytes — a 3x gap if `.length` were used.
  const body = "こんにちは";
  const wire = JSON.stringify({ to: ["b"], type: "t", body, ver: 1 });
  const expected = new TextEncoder().encode(wire).length;

  const bytes = a.send({ to: ["b"], type: "t", body });
  assertEquals(bytes, expected, "send() returns the UTF-8 byte count");
  assert(expected > wire.length, "the test string must actually be multibyte");
  assertEquals(a.stats().sentBytes, expected);

  a.destroy();
  await server.shutdown();
});

test("the queue's byte budget counts UTF-8 bytes", async () => {
  const { server, url } = startRoom();
  // Budget fits two of these messages in UTF-8, three if mis-counted as UTF-16.
  const body = "あ".repeat(100); // 300 UTF-8 bytes, 100 UTF-16 units
  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    sendQueue: { limit: 1000, maxBytes: 700 },
  });
  await connected(a);
  a.close();
  await until(() => !a.isConnected, 3000, "a disconnects");

  await captureConsole(() => {
    assert(a.send({ to: ["b"], type: "t", body }) > 0);
    assert(a.send({ to: ["b"], type: "t", body }) > 0);
    assertEquals(a.send({ to: ["b"], type: "t", body }), 0, "third exceeds");
  });
  assertEquals(a.stats().queued, 2);
  assert(a.stats().queuedBytes > 600, "queuedBytes is in UTF-8 bytes");

  a.destroy();
  await server.shutdown();
});

// ---------------------------------------------------------------- text + ver

test("text round-trip, and the sender declares ver 1", async () => {
  const { server, room, url } = startRoom();
  const seenByRoom: Record<string, unknown>[] = [];
  room.onFrame((f) => {
    if (f.kind === "text") seenByRoom.push(f.msg as Record<string, unknown>);
  });

  const a = new Pigeon({ baseUrl: url, address: ADDRESS, staticId: "a" });
  const b = new Pigeon({ baseUrl: url, address: ADDRESS, staticId: "b" });
  await connected(a);
  await connected(b);

  const got: { body: unknown; from: string }[] = [];
  b.addReceiveMessageListener({ type: "hello" }, (m) => got.push(m));

  const bytes = a.send({ to: ["b"], type: "hello", body: { n: 1 } });
  assert(bytes > 0, "send returns the serialised byte count");

  await until(() => got.length === 1, 3000, "b receives hello");
  assertEquals(got[0].body, { n: 1 });
  assertEquals(got[0].from, "a", "the room stamps `from`");

  const hello = seenByRoom.find((m) => m.type === "hello");
  assertEquals(hello?.ver, 1, "ver 1 is on the wire");

  a.destroy();
  b.destroy();
  await server.shutdown();
});

// -------------------------------------------------------------------- binary

test("binary round-trip: header envelope + raw payload", async () => {
  const { server, url } = startRoom();
  const a = new Pigeon({ baseUrl: url, address: ADDRESS, staticId: "a" });
  const b = new Pigeon({ baseUrl: url, address: ADDRESS, staticId: "b" });
  await connected(a);
  await connected(b);

  const frames: {
    body: unknown;
    from?: string;
    payload: Uint8Array;
    ver: number;
  }[] = [];
  const textSeen: unknown[] = [];
  b.addReceiveBinaryListener({ type: "depth-frame" }, (f) => frames.push(f));
  // The two streams must not cross.
  b.addReceiveMessageListener({ type: "depth-frame" }, (m) => textSeen.push(m));

  const payload = new Uint8Array(4096);
  payload.forEach((_, i) => (payload[i] = i & 0xff));

  const bytes = a.sendBinary({
    to: ["b"],
    type: "depth-frame",
    body: { seq: 7 },
    payloadMeta: { mimeType: "application/octet-stream" },
  }, payload);
  assert(bytes > 4096, `frame is header + payload, got ${bytes}`);

  await until(() => frames.length === 1, 3000, "b receives the binary frame");
  assertEquals(frames[0].body, { seq: 7 });
  assertEquals(frames[0].from, "a");
  assertEquals(frames[0].ver, 1);
  assertEquals(frames[0].payload.byteLength, 4096);
  assertEquals(frames[0].payload[4095], 4095 & 0xff);
  assertEquals(textSeen.length, 0, "binary must not reach the text listeners");

  a.destroy();
  b.destroy();
  await server.shutdown();
});

test("a binary frame is no longer reported as a malformed message", async () => {
  const { server, room, url } = startRoom();
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);

  try {
    const b = new Pigeon({ baseUrl: url, address: ADDRESS, staticId: "b" });
    await connected(b);
    let seen = 0;
    b.addReceiveBinaryListener("*", () => seen++);

    room.sendBinary(
      { from: "host", address: ADDRESS, to: ["b"], type: "blob", body: null },
      new Uint8Array([1, 2, 3]),
    );
    await until(() => seen === 1, 3000, "binary frame delivered");
    assertEquals(
      errors.length,
      0,
      `console.error was called: ${JSON.stringify(errors)}`,
    );
    b.destroy();
  } finally {
    console.error = realError;
    await server.shutdown();
  }
});

// ---------------------------------------------------------------- send queue

test("sendQueue holds while down and flushes, in order, on reopen", async () => {
  const { server, url } = startRoom();
  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    sendQueue: { limit: 10 },
  });
  const b = new Pigeon({ baseUrl: url, address: ADDRESS, staticId: "b" });
  await connected(a);
  await connected(b);

  const got: unknown[] = [];
  b.addReceiveMessageListener({ type: "queued" }, (m) => got.push(m.body));

  a.close();
  await until(() => !a.isConnected, 3000, "a disconnects");

  a.send({ to: ["b"], type: "queued", body: "one" });
  a.send({ to: ["b"], type: "queued", body: "two" });
  assertEquals(a.stats().queued, 2);
  assert(a.stats().queuedBytes > 0);

  a.reopen();
  await connected(a);
  await until(() => got.length === 2, 3000, "queue flushed");
  assertEquals(got, ["one", "two"]);
  assertEquals(a.stats().queued, 0);
  assertEquals(a.stats().queuedBytes, 0);

  a.destroy();
  b.destroy();
  await server.shutdown();
});

test("a full queue drops and counts instead of growing", async () => {
  const { server, url } = startRoom();
  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    sendQueue: { limit: 2 },
  });
  await connected(a);
  a.close();
  await until(() => !a.isConnected, 3000, "a disconnects");

  assert(a.send({ to: ["b"], type: "x", body: 1 }) > 0);
  assert(a.send({ to: ["b"], type: "x", body: 2 }) > 0);
  assertEquals(
    a.send({ to: ["b"], type: "x", body: 3 }),
    0,
    "third is dropped",
  );
  assertEquals(a.stats().queued, 2);
  assertEquals(a.stats().dropped, 1);

  a.destroy();
  await server.shutdown();
});

test("the byte budget bounds the queue where the count does not", async () => {
  const { server, url } = startRoom();
  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    sendQueue: { limit: 1000, maxBytes: 10_000 },
  });
  await connected(a);
  a.close();
  await until(() => !a.isConnected, 3000, "a disconnects");

  const payload = new Uint8Array(4096);
  assert(a.sendBinary({ to: ["b"], type: "f", body: null }, payload) > 0);
  assert(a.sendBinary({ to: ["b"], type: "f", body: null }, payload) > 0);
  assertEquals(
    a.sendBinary({ to: ["b"], type: "f", body: null }, payload),
    0,
    "a third frame would exceed maxBytes",
  );
  assertEquals(a.stats().queued, 2);

  a.destroy();
  await server.shutdown();
});

test("without sendQueue, send still throws when the socket is down", async () => {
  const { server, url } = startRoom();
  const a = new Pigeon({ baseUrl: url, address: ADDRESS, staticId: "a" });
  await connected(a);
  a.close();
  await until(() => !a.isConnected, 3000, "a disconnects");

  let threw = false;
  try {
    a.send({ to: ["b"], type: "x", body: 1 });
  } catch {
    threw = true;
  }
  assert(threw, "unchanged from v0.3.0");

  a.destroy();
  await server.shutdown();
});

// ----------------------------------------------------------------- keepalive

test("keepAlive pings the host, and the room pongs back", async () => {
  const { server, room, url } = startRoom();
  const pings: unknown[] = [];
  room.onFrame((f) => {
    if (f.kind === "text" && f.msg.type === "ping") pings.push(f.msg);
  });

  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    keepAlive: { intervalMs: 150, staleMs: 100_000 },
  });
  await connected(a);

  let pongs = 0;
  a.addReceiveMessageListener({ type: "pong" }, () => pongs++);

  await until(() => pings.length >= 2, 3000, "two keepalive pings out");
  await until(() => pongs >= 1, 3000, "a pong comes back");

  const s = a.stats();
  assertEquals(s.staleMs, 100_000);
  assert(
    s.inboundAgeMs !== null && s.inboundAgeMs < 1000,
    "the return path is fresh",
  );
  // Keepalive is transport traffic; it must not show up in the app's counters.
  assertEquals(s.sent, 0, "keepalive pings are not counted as sent messages");

  a.destroy();
  await server.shutdown();
});

// -------------------------------------------------------- half-open watchdog

/** A TCP proxy that can be told to go deaf: the sockets stay open, the bytes
 *  stop. This is the failure that has no event — no FIN, no RST, nothing for a
 *  `close` or `error` handler to fire on. */
function deafProxy(targetPort: number) {
  let deaf = false;
  const conns: Deno.Conn[] = [];
  const listener = Deno.listen({ port: 0 });
  (async () => {
    for await (const client of listener) {
      const upstream = await Deno.connect({ port: targetPort });
      conns.push(client, upstream);
      const pipe = async (from: Deno.Conn, to: Deno.Conn) => {
        const buf = new Uint8Array(65536);
        while (true) {
          const n = await from.read(buf);
          if (n === null) break;
          if (deaf) continue; // swallow: the far end never learns
          await to.write(buf.subarray(0, n));
        }
      };
      pipe(client, upstream).catch(() => {});
      pipe(upstream, client).catch(() => {});
    }
  })().catch(() => {});
  return {
    port: (listener.addr as Deno.NetAddr).port,
    goDeaf: () => (deaf = true),
    hear: () => (deaf = false),
    close: () => {
      listener.close();
      // Abandoned sockets would otherwise keep server.shutdown() waiting.
      for (const c of conns) {
        try {
          c.close();
        } catch { /* already gone */ }
      }
    },
  };
}

test("the watchdog notices a half-open socket and reconnects through it", async () => {
  const { server, port } = startRoom();
  const proxy = deafProxy(port);

  let disconnects = 0;
  let connects = 0;
  // No staticId: while the path is deaf the room still holds the old peer with
  // its socket reading OPEN, and `#resolveTargets` dedupes targets by id — so a
  // rejoin under the same id is shadowed by its own ghost until the room's
  // reaper clears it. Room-side, and out of this test's scope.
  const a = new Pigeon({
    baseUrl: `ws://localhost:${proxy.port}/pigeon`,
    address: ADDRESS,
    autoReconnect: true, // onCleanClose deliberately left off
    keepAlive: { intervalMs: 100, staleMs: 300 },
  });
  a.addDisconnectListener(() => disconnects++);
  a.addConnectListener(() => connects++);
  await connected(a);
  await until(() => connects === 1, 3000, "first connect");

  // The path goes silent without a FIN. readyState stays OPEN, no close event
  // is ever coming, and a close() handshake has nobody to shake hands with.
  proxy.goDeaf();
  await until(() => disconnects >= 1, 5000, "the watchdog notices");
  assert(!a.isConnected, "still down while the path is deaf");

  // The retry that follows gets swallowed mid-handshake and parks at
  // CONNECTING, where nothing will ever wake it. The connect timeout is what
  // keeps the heal moving.
  await until(() => disconnects >= 2, 5000, "the connect timeout fires");

  // And the heal has to land once the path comes back — this is also where
  // treating the forced close as an ordinary clean close would leave it dead.
  proxy.hear();
  await until(() => a.isConnected, 20000, "reconnect after the heal");
  assert(connects >= 2, `re-handshaked with the room (connects=${connects})`);

  // ...and it is a working connection, not merely an open socket.
  const echoed: unknown[] = [];
  a.addReceiveMessageListener({ type: "back" }, (m) => echoed.push(m));
  a.send({ to: [a.id!], type: "back", body: "alive" });
  await until(() => echoed.length === 1, 3000, "traffic flows again");

  a.destroy();
  proxy.close();
  await server.shutdown();
});

// ------------------------------------------------- rejoin shadowed by a ghost

test("a socket that opens but never receives init is retried until it joins", async () => {
  const { server, room, url } = startRoom();

  // An earlier connection under id "a". The room delivers a's init to it.
  const ghost = new WebSocket(`${url}?address=${ADDRESS}&initas=a`);
  await new Promise((r) => ghost.addEventListener("open", r, { once: true }));
  await until(
    () => room.pigeons.some((p) => p.id === "a"),
    3000,
    "the earlier connection joins",
  );

  const reasons: string[] = [];
  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    autoReconnect: true,
    keepAlive: { intervalMs: 100, staleMs: 300 },
  });
  a.addDisconnectListener((r) => reasons.push(r.reason));
  await until(() => a.stats().socketOpen, 3000, "a's socket opens");
  await new Promise((r) => setTimeout(r, 50));
  assert(!a.isConnected, "a's init went to the earlier connection");

  // From here on the room's pongs reach a's socket, so the watchdog stays quiet.
  const ghostClosed = new Promise((r) =>
    ghost.addEventListener("close", r, { once: true })
  );
  ghost.close();
  await ghostClosed;

  await until(() => a.isConnected, 5000, "a joins");
  assertEquals(a.id, "a");
  assert(
    reasons.some((r) => r.includes("init")),
    `the unjoined socket was abandoned (reasons: ${JSON.stringify(reasons)})`,
  );

  // A joined socket is left alone.
  const seen = reasons.length;
  await new Promise((r) => setTimeout(r, 700));
  assert(a.isConnected, "still joined");
  assertEquals(reasons.length, seen, "no disconnect after joining");

  a.destroy();
  await server.shutdown();
});

// ---------------------------------------------------------- clean-close rule

test("onCleanClose reconnects after the room reaps a quiet peer", async () => {
  const { server, room, url } = startRoom();
  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    autoReconnect: { onCleanClose: true },
  });
  await connected(a);
  const firstId = a.id;

  // Exactly what the 75 s reaper does: a bare, clean close from the room.
  room.pigeons.find((p) => p.id === "a")?.socket.close();
  await until(() => !a.isConnected, 3000, "a sees the clean close");
  await until(() => a.isConnected, 8000, "a reconnects anyway");
  assertEquals(a.id, firstId, "staticId keeps identity across the rejoin");

  a.destroy();
  await server.shutdown();
});

test("without onCleanClose, a clean close still means what it meant", async () => {
  const { server, room, url } = startRoom();
  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    autoReconnect: true,
  });
  await connected(a);

  room.pigeons.find((p) => p.id === "a")?.socket.close();
  await until(() => !a.isConnected, 3000, "a sees the clean close");
  await new Promise((r) => setTimeout(r, 1500));
  assert(!a.isConnected, "v0.3.0 behaviour preserved");

  a.destroy();
  await server.shutdown();
});

// --------------------------------------------------------- what stats() means

test("stats().connected means joined; socketOpen means the socket", async () => {
  const { server, url } = startRoom();
  const a = new Pigeon({ baseUrl: url, address: ADDRESS, staticId: "a" });

  // Between construction and `init`, the socket may be open but nothing has
  // joined — the shape the ghost-shadow window holds indefinitely.
  assertEquals(a.stats().connected, false);

  await connected(a);
  assertEquals(a.stats().connected, true);
  assertEquals(a.stats().socketOpen, true);

  a.close();
  await until(() => !a.isConnected, 3000, "a disconnects");
  assertEquals(a.stats().connected, false);
  assertEquals(a.stats().socketOpen, false);
  assertEquals(a.stats().inboundAgeMs, null);

  a.destroy();
  await server.shutdown();
});

// ------------------------------------------------ what a send event announces

test("send listeners fire on transmission, not on queueing", async () => {
  const { server, url } = startRoom();
  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    sendQueue: true,
  });
  await connected(a);

  const announced: unknown[] = [];
  a.addSendMessageListener({ type: "later" }, (m) => announced.push(m.body));

  a.close();
  await until(() => !a.isConnected, 3000, "a disconnects");

  a.send({ to: ["b"], type: "later", body: "one" });
  a.send({ to: ["b"], type: "later", body: "two" });
  // Handlers run in a microtask; give them a turn to prove they did not fire.
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(announced, [], "nothing has left the process yet");
  assertEquals(a.stats().queued, 2);

  a.reopen();
  await connected(a);
  await until(() => announced.length === 2, 3000, "announced on flush");
  assertEquals(announced, ["one", "two"]);

  a.destroy();
  await server.shutdown();
});

test("a queue discarded by destroy() never announced its messages", async () => {
  const { server, url } = startRoom();
  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    sendQueue: true,
  });
  await connected(a);
  let announced = 0;
  a.addSendMessageListener("*", () => announced++);

  a.close();
  await until(() => !a.isConnected, 3000, "a disconnects");
  a.send({ to: ["b"], type: "ghost", body: 1 });
  a.destroy();

  await new Promise((r) => setTimeout(r, 50));
  assertEquals(announced, 0, "a discarded message was never sent");

  await server.shutdown();
});

// ------------------------------------------------------ control frames' scope

test("ping()/pong() are never queued for the next connection", async () => {
  const { server, url } = startRoom();
  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    sendQueue: true,
  });
  await connected(a);
  a.close();
  await until(() => !a.isConnected, 3000, "a disconnects");

  // sendQueue is on, but a pong is worth nothing on a later connection.
  assertThrows(() => a.pong(["b"]));
  assertThrows(() => a.ping(["b"]));
  assertEquals(a.stats().queued, 0);
  // ...while an ordinary send still queues.
  a.send({ to: ["b"], type: "ordinary", body: 1 });
  assertEquals(a.stats().queued, 1);

  a.destroy();
  await server.shutdown();
});

// ---------------------------------------------------------- option validation

test("a staleMs shorter than the ping interval is clamped, not obeyed", async () => {
  const { server, url } = startRoom();
  let a!: Pigeon;
  const { warns } = await captureConsole(() => {
    a = new Pigeon({
      baseUrl: url,
      address: ADDRESS,
      staticId: "a",
      autoReconnect: true,
      keepAlive: { intervalMs: 200, staleMs: 50 },
    });
  });
  assert(
    warns.some((w) => w.includes("staleMs")),
    `expected a staleMs warning, got ${JSON.stringify(warns)}`,
  );
  assertEquals(a.stats().staleMs, 400, "clamped to 2x intervalMs");

  // The point of the clamp: an unclamped 50 ms would abandon this healthy
  // connection on the watchdog's first tick, and on every generation after.
  await connected(a);
  let disconnects = 0;
  a.addDisconnectListener(() => disconnects++);
  await new Promise((r) => setTimeout(r, 1200));
  assertEquals(disconnects, 0, "a healthy connection survives");
  assert(a.isConnected);

  a.destroy();
  await server.shutdown();
});

test("keepAlive without autoReconnect warns that nothing will reopen", async () => {
  const { server, url } = startRoom();
  let a!: Pigeon;
  const { warns } = await captureConsole(() => {
    a = new Pigeon({ baseUrl: url, address: ADDRESS, keepAlive: true });
  });
  assert(
    warns.some((w) => w.includes("keepAlive") && w.includes("autoReconnect")),
    `expected a keepAlive/autoReconnect warning, got ${JSON.stringify(warns)}`,
  );

  a.destroy();
  await server.shutdown();
});

// ------------------------------------------------------------- ver is not the
//                                                                caller's to set

test("a stray `ver` on the message cannot override the format version", async () => {
  const { server, room, url } = startRoom();
  const seen: Record<string, unknown>[] = [];
  room.onFrame((f) => {
    if (f.kind === "text") seen.push(f.msg as Record<string, unknown>);
  });

  const a = new Pigeon({ baseUrl: url, address: ADDRESS, staticId: "a" });
  await connected(a);

  // What a bridge relaying a parsed frame would hand over. The wider type is
  // the point: excess-property checking only guards object literals.
  const relayed = { to: ["b"], type: "relayed", body: 1, ver: 0 };
  a.send(relayed);

  await until(
    () => seen.some((m) => m.type === "relayed"),
    3000,
    "the room sees it",
  );
  assertEquals(seen.find((m) => m.type === "relayed")?.ver, 1);

  a.destroy();
  await server.shutdown();
});

// --------------------------------------------------------- warning throttling

test("a congestion warning does not silence an unrelated drop warning", async () => {
  const { server, url } = startRoom();
  const a = new Pigeon({
    baseUrl: url,
    address: ADDRESS,
    staticId: "a",
    sendQueue: { limit: 1 },
  });
  await connected(a);
  a.close();
  await until(() => !a.isConnected, 3000, "a disconnects");

  const { warns } = await captureConsole(() => {
    // Two categories, back to back, well inside the 5 s throttle window.
    a.send({ to: ["b"], type: "x", body: 1 }); // fills the queue
    a.send({ to: ["b"], type: "x", body: 2 }); // drops → warns
  });
  assertEquals(
    warns.filter((w) => w.includes("send queue full")).length,
    1,
    `expected the drop warning to survive, got ${JSON.stringify(warns)}`,
  );

  a.destroy();
  await server.shutdown();
});
