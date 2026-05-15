# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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

### Fixed

- `isConnected` is now reset to `false` when the underlying WebSocket emits
  `close` or `error`. Previously it stayed `true` after the socket dropped.
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
