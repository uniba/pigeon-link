# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-08-17

Everything here already existed, hand-rolled on a raw `WebSocket`, inside
`hyper-icc-kids2026-venue-server`'s outbound bridge to the internet Pigeon Room.
It is moved here so the next client does not have to write it again — and so the
two failure modes below stop being everyone's to rediscover.

### Added

- **Binary frames.** `sendBinary(message, payload)` writes a
  `@circuitlab/pigeon-message` v1 binary frame (a JSON header plus raw bytes);
  `addReceiveBinaryListener` / `removeReceiveBinaryListener` subscribe to
  incoming ones, filtered by `type` exactly as the text listeners are. Binary
  and text stay separate streams — a text listener never sees a binary frame and
  vice versa. `ReceivedBinaryMessage`, `SendBinaryMessage`, `BinaryFrameHeader`
  and `ParsedBinaryFrame` are exported from `types.ts`.
- **`keepAlive`** option: pings the host every `intervalMs` (default 30 s) and
  watches for the room having gone silent for `staleMs` (default 90 s). Two jobs
  at once — the ping keeps the room's own idle reaper from collecting an idle
  publisher, and the silence is the only available evidence that a half-open
  socket has stopped carrying anything.
- **`keepAlive.connectTimeoutMs`** (default `staleMs`): abandons a socket that
  has not joined in time — left sitting in `CONNECTING`, or open without the
  room's `init` — and schedules the next attempt.
- **`autoReconnect.onCleanClose`**: also reconnect when the peer closes cleanly.
  Defaults to `false`. Set it against a room that may close a connection it
  still expects to keep — `@circuitlab/pigeon-room` up to v1.1.4 reaps a peer
  that has not _sent_ for 75 s with a clean close.
- **`sendQueue`** option: holds messages sent while the socket is down and
  flushes them, in order, on reconnect. Bounded by both a message count
  (`limit`, default 1000) and a byte budget (`maxBytes`, default 8 MB) — a count
  alone is not a bound once binary frames are queued. Overflow is dropped and
  counted rather than grown.
- **`stats()`**: `connected`, `socketOpen`, `queued`, `queuedBytes`, `buffered`,
  `sent`, `sentBytes`, `dropped`, `inboundAgeMs`, `staleMs` — enough for a
  `/status` endpoint to show that a client is connected _and_ keeping up, which
  are different questions. `connected` reports having joined (the `init`
  handshake completed); `socketOpen` is the transport-level answer, and the two
  come apart in the `staticId` window described below.
- `send()` and `sendBinary()` return the byte count written (or queued), or `0`
  when the message was dropped, so a caller can meter its own egress. Text is
  measured in UTF-8 bytes — what goes on the wire — not UTF-16 code units, so
  the figure is comparable with the binary path's and with the queue's
  `maxBytes` budget.
- keepAlive timings are validated at construction: a non-positive `intervalMs`,
  or a `staleMs` shorter than two ping intervals, is clamped with a warning.
  Left unclamped, a `staleMs` below `intervalMs` tears down healthy connections
  on the watchdog's first tick, on every generation — which from outside looks
  exactly like the network fault keepAlive exists to survive. Enabling
  `keepAlive` without `autoReconnect` also warns, since nothing would reopen the
  socket the watchdog closes.
- A `console.warn` when the socket's own `bufferedAmount` passes 1 MB. What to
  shed is the application's decision; it can only make it on evidence.

### Fixed

- **A binary frame is no longer reported as a malformed message.** Frames
  arrived as `Blob`s and went to the text parser, which threw and logged, once
  per frame — a 30 Hz stream flooded the console until the page wedged. The
  socket now asks for `arraybuffer` and binary is decoded on its own path.
- **A half-open socket is now detected and healed.** When the network path
  disappears without a FIN, no `close` and no `error` ever fire, `readyState`
  stays `OPEN`, and everything sent from then on goes nowhere. With `keepAlive`
  on, the watchdog notices and reconnects.
- **A stalled reconnect no longer wedges the client.** Healing a half-open
  socket with `close()` does not work: `close()` opens a _handshake_, and the
  peer is precisely what has gone missing, so the socket parks in `CLOSING` and
  the `close` event that would trigger the reconnect never arrives. The watchdog
  now detaches the socket, announces the disconnect itself (code `1006`) and
  schedules the reconnect. The retry after it is equally exposed — the same dead
  path swallows the opening handshake — which is what `connectTimeoutMs` covers.
- **A rejoin shadowed by its own `staticId` ghost no longer stays unjoined.**
  The room delivers `init` to the previous connection while it still holds it,
  and does not send it again once that connection is gone. The new socket then
  kept `connected: false` indefinitely, while pongs reaching it kept the
  watchdog satisfied. With `keepAlive`, a socket that has not received `init`
  within `connectTimeoutMs` is now abandoned and retried.

### Changed

- Outgoing text messages now carry `ver: 1`, as the pigeon-message spec has
  always required of senders. Rooms that do not read `ver` are unaffected
  (absent is specified to mean v0), but the declaration is now correct. It is
  written last, so a `ver` carried on a relayed message cannot misdeclare the
  format this client speaks.
- `send()` returns `number` where it returned `void`. Without `sendQueue` it
  still throws when the socket is not `OPEN`, unchanged from v0.3.0.
- Send-listener events fire when a message reaches the socket. With `sendQueue`,
  that is at flush time rather than when the message is accepted, so a listener
  never announces a send still sitting in memory — or one that `destroy()` goes
  on to discard.
- `ping()` and `pong()` are never queued, even with `sendQueue` on: a pong is
  worth something only on the connection that asked for it, and one delivered
  after a reconnect answers a ping from a socket that no longer exists. They
  throw while the socket is down, as in v0.3.0.

### Known limitation (room-side, not fixed here)

Reconnecting with a `staticId` while the room still holds the previous peer
under that id — which is exactly the window a half-open socket opens, since the
room's side also still reads `OPEN` — is shadowed: `pigeon-room`'s
`#resolveTargets` dedupes targets by id, so `init`, and anything else addressed
to that id, goes to the ghost. The room does not send `init` again once it has
collected the stale peer. With `keepAlive`, the client retries every
`connectTimeoutMs` (plus the reconnect backoff) and joins on the first attempt
after the room has let the ghost go. Without `keepAlive` it stays unjoined until
its next reconnect. Reconnecting without a `staticId` is unaffected.

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
- `close()`: deliberately closes the socket and stops auto-reconnect while
  keeping the instance and its listeners intact, for an app-initiated disconnect
  where listeners should still observe the `disconnect` event.
- `reopen()`: re-opens the connection after a `close()`, reusing the same
  options and already-registered listeners. No-op while a socket is still `OPEN`
  or `CONNECTING`, so it cannot orphan a live socket. The counterpart to
  `close()`.
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
  to automatically re-open the WebSocket on an unclean close using exponential
  backoff (500ms doubling up to 30s). A clean close (this instance's `close()`,
  or a clean close initiated by the peer) does not reconnect. Listeners are
  preserved across reconnects. The attempt counter resets when the `init`
  handshake completes. `close()` and `destroy()` stop reconnect attempts.
- `AutoReconnectOptions` type exported from `types.ts`.

### Fixed

- Multiple `Pigeon` instances no longer cross-pollute each other's internal
  state. Previously internal handlers (the `init` handshake, the ping responder)
  listened on the global event target, so a message arriving on instance A would
  overwrite `B.id`. Internal handlers and `add*Listener` registrations now live
  on each instance's private `EventTarget`. Bare `pigeon:receive` /
  `pigeon:send` events are still dispatched on `globalThis` (so
  `window.addEventListener("pigeon:receive", ...)` keeps working as in v0.2.0);
  the new type-segmented form (`pigeon:receive:{...}`) is per-instance only. As
  a side effect, `add*Listener`-registered handlers are released when the
  instance is garbage-collected, fixing the latent leak from `onReceiveMessage`
  callers who discarded a `Pigeon` without calling `destroy()`.
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
