# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- `addReceiveMessageListener` / `removeReceiveMessageListener` / `addSendMessageListener` / `removeSendMessageListener`: removable listener APIs that follow the standard `addEventListener` pattern.
- Type-segmented event dispatching: messages are dispatched as `pigeon:receive:{...filter}` / `pigeon:send:{...filter}` events, so native EventAPI options (`once`, `signal`, etc.) work as expected when a string `type` filter is used.

### Fixed

- `{ once: true }` was previously consumed by the first received/sent message regardless of its `type`, because a single `pigeon:receive` / `pigeon:send` event was used with internal filtering. String `type` filters now subscribe to type-specific events directly, so `once` behaves as expected.

### Deprecated

- `onReceiveMessage(target, handler, options?)`: use `addReceiveMessageListener` instead. Will be removed in v1.0.0.
- `onSendMessage(target, handler, options?)`: use `addSendMessageListener` instead. Will be removed in v1.0.0.

### Changed

- `addReceiveMessageListener` / `addSendMessageListener` with a `RegExp` `type` no longer accept the `options` argument (enforced at the type level). Use a `string` `type` if you need native EventAPI option support.

## [0.2.0] - 2025-08-20

- Initial published version.
