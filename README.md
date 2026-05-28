# Pigeon link

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

## `destroy()`

Closes the underlying WebSocket and unregisters every listener this instance has
added. Call it when the Pigeon will not be used again (route change, component
unmount, etc.) to release resources promptly.

```typescript
pigeon.destroy();
```

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
- All `pigeon:receive` / `pigeon:send` events (the bare form and the new
  type-segmented form like `pigeon:receive:{"type":"init"}`) are now dispatched
  on a private `EventTarget` owned by each `Pigeon` instance, instead of on
  `window` / `globalThis`. Calling
  `window.addEventListener("pigeon:receive", ...)` doesn't break the module — it
  just won't fire anymore. To listen for every message, use
  `pigeon.addReceiveMessageListener("*", handler)` /
  `pigeon.addSendMessageListener("*", handler)` instead.

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
