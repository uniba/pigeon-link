# Pigeon link

> **v0.4.0 notice**: binary frames are now supported (`sendBinary` /
> `addReceiveBinaryListener`), and three options make a connection survive a
> network that misbehaves: `keepAlive`, `sendQueue`, and
> `autoReconnect.onCleanClose`. All are opt-in; leaving them unset keeps v0.3.0
> behaviour. See [Staying connected](#staying-connected),
> [Binary messages](#binary-messages) and [CHANGELOG.md](./CHANGELOG.md).
>
> **v0.3.0 notice**:
>
> - `onReceiveMessage` / `onSendMessage` are deprecated and will be removed in
>   v1.0.0. Use `addReceiveMessageListener` / `addSendMessageListener` instead.
> - **Breaking**: When `target.type` is a `RegExp`, the `options` argument is no
>   longer accepted (enforced at the type level; ignored with a warning at
>   runtime). Use a `string` `type` for native EventAPI options like `once` /
>   `signal`.
> - The wildcard form is now `"*"` passed as the first argument directly.
>   `{ type: "*" }` is deprecated and will be removed in v1.0.0.
>
> See [Migration to v0.3.0](#migration-to-v030) and
> [CHANGELOG.md](./CHANGELOG.md) for details.

Pigeon link is a module for connecting to a Pigeon Room.

## Connect to Pigeon Room

```typescript
const pigeon = new Pigeon({
  baseUrl: "wss://your-pigeon-room/pigeon",
  address: "address",
  staticId: "staticid", // optional
  autoReconnect: true, // optional
});
```

Note: with `autoReconnect`, a new client id is assigned on each reconnect unless
`staticId` is specified. Re-read it from `pigeon.id` after reconnect (e.g.
inside `addConnectListener`).

A long-lived client — a server-side bridge, a screen left running for weeks —
wants more than this. See [Staying connected](#staying-connected).

## Send a message

```typescript
const bytes = pigeon.send({
  to: ["peer-id"], // or ["all"] / ["others"] / ["host"]
  type: "messageType",
  body: { any: "JSON" },
});
```

The client supplies `type`, `to` and `body`; the room stamps `from`, `address`
and `timestamp` on relay, and `ver: 1` is added for you (and wins over any `ver`
the message already carries). The return value is the **UTF-8** byte count —
what actually goes on the wire, and `0` if the message was dropped — so a caller
can meter its own egress.

By default this **throws** when the socket is not `OPEN`. See
[`sendQueue`](#sendqueue) to hold messages through a disconnect instead, and
[`sendBinary`](#sendbinarymessage-payload) for binary frames.

`ping(to)` / `pong(to)` are the two exceptions to the queue: they always throw
rather than wait for the next connection, because a pong delivered after a
reconnect answers a ping from a socket that no longer exists.

## Listen for message events

Handlers can be registered to listen for specific message types, both for
receiving and sending messages.

### `addReceiveMessageListener(target, handler, options?)`

```typescript
pigeon.addReceiveMessageListener<T>({
  type: "messageType",
}, receiveHandler);

// Match every message
pigeon.addReceiveMessageListener("*", receiveHandler);
```

- target
  - `"*"` | `{ type: string }` | `{ type: RegExp }`
    - Specifies which messages to listen for.
    - `"*"` matches every message. `options` (e.g. `once`) work natively.
    - `{ type: string }` matches messages whose `type` is exactly equal.
      `options` work natively.
    - `{ type: RegExp }` matches messages whose `type` matches the pattern.
      **Note**: with a `RegExp`, the `options` argument is not accepted (the
      underlying listener does internal filtering, which would consume options
      like `once` on filtered-out messages). Use a string `type` or `"*"` if you
      need EventAPI options.

- handler

```typescript
(message: ReceivedMessage<T>) => void
```

A callback function that will be invoked when a matching message is received.

- options
  - boolean | AddEventListenerOptions — same as the standard `addEventListener`
    third argument (`once`, `signal`, etc.).

### `removeReceiveMessageListener(target, handler, options?)`

Removes a previously registered receive handler. The same `target.type` and
`handler` reference must be passed to identify which listener to remove.

```typescript
pigeon.removeReceiveMessageListener({
  type: "messageType",
}, receiveHandler);
```

### `addSendMessageListener(target, handler, options?)`

```typescript
pigeon.addSendMessageListener<T>({
  type: "messageType",
}, sendHandler);

// Match every message
pigeon.addSendMessageListener("*", sendHandler);
```

- target
  - `"*"` | `{ type: string }` | `{ type: RegExp }`
    - Specifies which messages to listen for.
    - `"*"` matches every message. `options` (e.g. `once`) work natively.
    - `{ type: string }` matches messages whose `type` is exactly equal.
      `options` work natively.
    - `{ type: RegExp }` matches messages whose `type` matches the pattern.
      **Note**: with a `RegExp`, the `options` argument is not accepted (the
      underlying listener does internal filtering, which would consume options
      like `once` on filtered-out messages). Use a string `type` or `"*"` if you
      need EventAPI options.

- handler

```typescript
(message: SendMessage<T>) => void
```

A callback function that will be invoked when a matching message is sent.

- options
  - boolean | AddEventListenerOptions — same as the standard `addEventListener`
    third argument (`once`, `signal`, etc.).

### `removeSendMessageListener(target, handler, options?)`

Removes a previously registered send handler. The same `target.type` and
`handler` reference must be passed to identify which listener to remove.

```typescript
pigeon.removeSendMessageListener({
  type: "messageType",
}, sendHandler);
```

## Binary messages

A binary message is a WebSocket binary frame: a JSON header carrying the same
envelope as a text message, plus raw payload bytes. It is a separate stream from
text — a text listener never sees a binary frame, and the reverse.

### `sendBinary(message, payload)`

```typescript
const bytes = pigeon.sendBinary({
  to: ["peer-id"],
  type: "depth-frame",
  body: { seq: 12 },
  payloadMeta: { mimeType: "application/octet-stream" }, // optional
}, new Uint8Array(buffer));
```

Returns the frame's byte count when it goes out (or is queued), `0` when it was
dropped. The header is capped at 65535 bytes by the format, so keep bulk data in
the payload — `sendBinary` throws if the header is over.

### `addReceiveBinaryListener(target, handler, options?)`

Same `target` forms as `addReceiveMessageListener`: `"*"`, `{ type: string }`,
`{ type: RegExp }`.

```typescript
pigeon.addReceiveBinaryListener({ type: "depth-frame" }, (frame) => {
  frame.body; // the header's application body
  frame.from; // set by the room
  frame.payload; // Uint8Array
});
```

`payload` is a **view onto the received buffer, not a copy**. Reading it is
free; holding it past the handler holds the whole frame alive, so copy out what
you intend to keep.

Two shapes to expect: the room does not stamp `timestamp` on binary frames (only
on text), and `from` / `address` are typed optional because the spec types them
that way — in practice `pigeon-room` sets both.

### `removeReceiveBinaryListener(target, handler, options?)`

The counterpart. The same `target.type` and `handler` reference must be passed.

## Staying connected

The defaults suit a page that is open for a few minutes. A client that must hold
a connection for weeks — a server-side bridge, an unattended screen — needs the
three options below. All are opt-in.

### `keepAlive`

```typescript
const pigeon = new Pigeon({
  baseUrl: "wss://your-pigeon-room/pigeon",
  address: "address",
  autoReconnect: true,
  keepAlive: true, // or { intervalMs, staleMs, connectTimeoutMs }
});
```

Two problems, one mechanism.

The first is that a room reaps quiet peers. `@circuitlab/pigeon-room` up to
v1.1.4 closes any connection that has not _sent_ anything for 75 s, and a
receive-only client or an idle publisher looks exactly like a dead one — in the
quiet hour before anyone arrives, which is the hour someone checks that it
works. The ping (default every 30 s) keeps the room's clock advancing.

The second is that a network path can disappear without a FIN. No `close`, no
`error`, `readyState` still `OPEN`, and every send from then on goes nowhere.
The only evidence available is silence, so a connection that has not received
_any_ frame for `staleMs` (default 90 s) is treated as gone and reconnected.
Note that a `close()` cannot heal this — a close is a handshake, and the peer is
what went missing — so the socket is abandoned outright and the disconnect is
reported with code `1006`.

`connectTimeoutMs` (default: `staleMs`) covers the same failure one step later:
the network that ate the connection eats the handshake that would replace it,
leaving a socket at `CONNECTING` that nothing will ever wake.

Two things are checked at construction. `staleMs` must outlast two ping
intervals — set it shorter and the watchdog fires before a pong to its own ping
can arrive, tearing down healthy connections forever — so a smaller value is
clamped with a warning. And `keepAlive` wants `autoReconnect`: the watchdog ends
a stalled connection on the assumption something will start a new one, so
without it the client is closed and left that way (warned about at
construction). Handle it yourself with `reopen()` from an
`addDisconnectListener` if you want keepAlive without automatic reconnects.

### `autoReconnect: { onCleanClose: true }`

By default a _clean_ close is taken at its word and no reconnect follows. Set
this against a room that may close a connection it still expects to keep — the
75 s reaper above closes cleanly. With `keepAlive` on it should never fire; this
is the belt to its braces.

### `sendQueue`

```typescript
const pigeon = new Pigeon({
  baseUrl: "wss://your-pigeon-room/pigeon",
  address: "address",
  autoReconnect: true,
  sendQueue: true, // or { limit, maxBytes }
});
```

Without it, `send()` throws while the socket is down. With it, messages are held
and flushed in order on reconnect, bounded by both a message count (`limit`,
default 1000) and a byte budget (`maxBytes`, default 8 MB) — a count alone stops
being a bound as soon as binary frames are queued. Past either bound, messages
are dropped and counted in `stats().dropped` rather than growing without end.

Send-listener events fire when a message actually reaches the socket, so a
queued message is announced at flush time, not when it was accepted.

### `stats()`

```typescript
pigeon.stats();
// { connected, socketOpen, queued, queuedBytes, buffered, sent, sentBytes,
//   dropped, inboundAgeMs, staleMs }
```

Connected and keeping up are different questions, and a status endpoint should
be able to answer both. `queued` (socket down) and `buffered` (socket open,
behind) are the two shapes congestion takes; `inboundAgeMs` climbing toward
`staleMs` is a return path about to be declared dead.

`connected` means **joined** — the `init` handshake completed — while
`socketOpen` is the transport-level answer. They come apart in the `staticId`
window described in [CHANGELOG.md](./CHANGELOG.md), where a rejoin shadowed by
its own ghost holds an open socket that never receives its `init`; reporting the
socket there would show a healthy client that is in fact deaf.

## Connection lifecycle

### `addConnectListener(handler, options?)` / `removeConnectListener(handler, options?)`

Fires when the `init` handshake from the host completes (i.e. when `pigeon.id`
is assigned and `pigeon.isConnected` becomes `true`).

```typescript
pigeon.addConnectListener(() => {
  console.log("connected as", pigeon.id);
});
```

### `addDisconnectListener(handler, options?)` / `removeDisconnectListener(handler, options?)`

Fires when the underlying WebSocket closes — cleanly, due to a network error
mid-stream, or because the initial connection attempt failed. The handler
receives a `{ code, reason, wasClean }` object extracted from the WebSocket
`CloseEvent`.

```typescript
pigeon.addDisconnectListener(({ code, reason, wasClean }) => {
  console.log("disconnected", { code, reason, wasClean });
});
```

`options` for both APIs accepts the standard `addEventListener` third argument
(`once`, `signal`, etc.).

## `close()`

Deliberately closes the underlying WebSocket and stops auto-reconnect, while
keeping the instance and its listeners intact. Use it for an app-initiated
disconnect (e.g. the user logged out) where registered listeners should still
observe the `disconnect` event.

```typescript
pigeon.close();
```

With `autoReconnect` enabled, an ordinary close — including a clean close
initiated by the peer — does **not** reconnect; only an unclean drop (network
error, etc.) does. `close()` additionally cancels any pending reconnect attempt,
so it is the way to stop the reconnect loop without discarding the instance.

## `reopen()`

Re-opens the connection after a `close()`, reusing the same options and the
already-registered listeners — the counterpart to `close()`. Use it to reconnect
to the same room without recreating the instance (e.g. the user logs back in).

```typescript
pigeon.close();
// ...later
pigeon.reopen();
```

It is a no-op while a socket is still `OPEN` or `CONNECTING`, so calling it on a
live connection will not orphan the current socket. As with `autoReconnect`, a
fresh client id is assigned on rejoin unless `staticId` was specified; re-read
it from `pigeon.id` after reconnecting.

## `destroy()`

Closes the underlying WebSocket and unregisters every listener this instance has
added. Call it when the Pigeon will not be used again (route change, component
unmount, etc.) to release resources promptly.

```typescript
pigeon.destroy();
```

Note: listeners you register directly on `window` / `globalThis` (e.g.
`window.addEventListener("pigeon:receive", ...)`) are outside this instance's
bookkeeping and will not be removed by `destroy()` — call `removeEventListener`
yourself.

## Auto send pong on receive ping

Automatically replies with a pong message when `ping` is receivec.

## Migration to v0.3.0

- `onReceiveMessage` / `onSendMessage` are now deprecated. Replace them with
  `addReceiveMessageListener` / `addSendMessageListener`. The deprecated methods
  are still available as aliases until v1.0.0.
- **Breaking**: `addReceiveMessageListener` / `addSendMessageListener` (and the
  deprecated aliases) no longer accept the `options` argument when `target.type`
  is a `RegExp`. Calling with both will fail to type-check, and at runtime the
  `options` argument is silently ignored with a `console.warn`. Use a `string`
  `type` if you need EventAPI options.
- The wildcard form moved from `{ type: "*" }` to `"*"` as the first argument:
  ```typescript
  // Before
  pigeon.addReceiveMessageListener({ type: "*" }, handler);
  // After
  pigeon.addReceiveMessageListener("*", handler);
  ```
  `{ type: "*" }` still works in v0.3.0 with a `console.warn`, and will be
  removed in v1.0.0. The change disambiguates "match every message" from a
  future filter-object API where omitting a key means "no constraint on that
  key".

## Deprecated APIs

The following methods are kept as aliases for backward compatibility. New code
should prefer the `add*` / `remove*` variants.

- `onReceiveMessage(target, handler, options?)` — alias of
  `addReceiveMessageListener`.
- `onSendMessage(target, handler, options?)` — alias of
  `addSendMessageListener`.

Listeners registered with the deprecated methods can still be removed via
`removeReceiveMessageListener` / `removeSendMessageListener` by passing the same
`target.type` and `handler`.
