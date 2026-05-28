# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-05-29

### Added

- `addReceiveMessageListener` / `removeReceiveMessageListener` /
  `addSendMessageListener` / `removeSendMessageListener`: removable listener
  APIs that follow the standard `addEventListener` pattern.
- Type-segmented event dispatching: messages are dispatched as
  `pigeon:receive:{...filter}` / `pigeon:send:{...filter}` events, so native
  EventAPI options (`once`, `signal`, etc.) work as expected when a string
  `type` filter is used.
- `"*"` literal as the first argument of the listener APIs to match every
  message (e.g.
  `pigeon.addReceiveMessageListener("*", handler, { once: true })`).
- `destroy()`: closes the socket and unregisters every listener this instance
  has added. Use it to release resources when the Pigeon will not be used again.
- `addConnectListener` / `removeConnectListener`: subscribe to a
  `pigeon:connect` event fired when the `init` handshake from the host
  completes.
- `addDisconnectListener` / `removeDisconnectListener`: subscribe to a
  `pigeon:disconnect` event fired when the underlying WebSocket closes (cleanly,
  mid-stream, or because the initial connection attempt failed). The handler
  receives `{ code, reason, wasClean }` extracted from the `CloseEvent`. This
  also gives callers a way to detect a failed initial connection, which
  previously had no observable signal.
- `DisconnectReason` type exported from `types.ts` for the disconnect handler
  payload.
- `autoReconnect` option on `PigeonOptions`: pass `true` (or `{ maxAttempts }`)
  to automatically re-open the WebSocket on close using exponential backoff
  (500ms doubling up to 30s). Listeners are preserved across reconnects. The
  attempt counter resets when the `init` handshake completes. `destroy()`
  permanently stops reconnect attempts.
- `AutoReconnectOptions` type exported from `types.ts`.

### Fixed

- Multiple `Pigeon` instances no longer cross-pollute each other's listeners.
  Previously every instance dispatched on the global event target and every
  registered handler listened on the global event target, so a message arriving
  on instance A would also fire instance B's handlers (and overwrite fields like
  `B.id`). Each instance now owns a private `EventTarget`. As a side effect,
  listeners are released when the instance is garbage-collected, fixing a latent
  leak when callers discarded a `Pigeon` without calling `destroy()`.
- `isConnected` is now reset to `false` when the underlying WebSocket emits
  `close` or `error`. Previously it stayed `true` after the socket dropped.
- Malformed incoming messages (invalid JSON, or JSON that doesn't match the
  message schema) are now logged via `console.error` and dropped, instead of
  surfacing as an uncaught error from the WebSocket message callback.
- `send()` now throws a clear, Pigeon-specific error when the underlying socket
  is not in the `OPEN` state, instead of letting the lower-level
  `InvalidStateError` from `WebSocket.send` propagate.
- `{ once: true }` was previously consumed by the first received/sent message
  regardless of its `type`, because a single `pigeon:receive` / `pigeon:send`
  event was used with internal filtering. String `type` filters now subscribe to
  type-specific events directly, so `once` behaves as expected.

### Deprecated

- `onReceiveMessage(target, handler, options?)`: use `addReceiveMessageListener`
  instead. Will be removed in v1.0.0.
- `onSendMessage(target, handler, options?)`: use `addSendMessageListener`
  instead. Will be removed in v1.0.0.
- `{ type: "*" }` as a wildcard target: pass `"*"` directly as the first
  argument instead. The legacy form still works with a `console.warn` and will
  be removed in v1.0.0.

### Changed

- `addReceiveMessageListener` / `addSendMessageListener` with a `RegExp` `type`
  no longer accept the `options` argument (enforced at the type level). Use a
  `string` `type` if you need native EventAPI option support.

## [0.2.0] - 2025-08-20

- Initial published version.
