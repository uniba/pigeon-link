# Pigeon link

Pigeon link is a module for connecting to a Pigeon Room.

## Connect to Pigeon Room

```typescript
const pigeon = new Pigeon({
    baseUrl: "wss://your-pigeon-room/pigeon",
    address: "address",
    staticId: "staticid", // optional
});
```

## Listen for message events

Handlers can be registered to listen for specific message types, both for receiving and sending messages.

### `addReceiveMessageListener(target, handler, options?)`

```typescript
pigeon.addReceiveMessageListener<T>({
  type: "messageType",
}, receiveHandler);
```

- target
    - type: string | RegExp
        - Specifies the type of message to listen for.
        - If a string is provided, it matches messages with the exact same type (use "*" as a wildcard to match all types).
        - If a regular expression is provided, the handler will be triggered when the received message type matches the pattern.

- handler
```typescript
(message: ReceivedMessage<T>) => void
```
A callback function that will be invoked when a matching message is received.

- options
    - boolean | AddEventListenerOptions
        Options are passed directly to `addEventListener("pigeon:receive", ...)`.

### `removeReceiveMessageListener(target, handler, options?)`

Removes a previously registered receive handler. The same `target.type` and `handler` reference must be passed to identify which listener to remove.

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
```

- target
    - type: string | RegExp
        - Specifies the type of message to listen for.
        - If a string is provided, it matches messages with the exact same type (use "*" as a wildcard to match all types).
        - If a regular expression is provided, the handler will be triggered when the sent message type matches the pattern.

- handler
```typescript
(message: SendMessage<T>) => void
```
A callback function that will be invoked when a matching message is sent.

- options
    - boolean | AddEventListenerOptions
        Options are passed directly to `addEventListener("pigeon:send", ...)`.

### `removeSendMessageListener(target, handler, options?)`

Removes a previously registered send handler. The same `target.type` and `handler` reference must be passed to identify which listener to remove.

```typescript
pigeon.removeSendMessageListener({
  type: "messageType",
}, sendHandler);
```

## Auto send pong on receive ping

Automatically replies with a pong message when `ping` is receivec.

## Deprecated APIs

The following methods are kept as aliases for backward compatibility. New code should prefer the `add*` / `remove*` variants.

- `onReceiveMessage(target, handler, options?)` — alias of `addReceiveMessageListener`.
- `onSendMessage(target, handler, options?)` — alias of `addSendMessageListener`.

Listeners registered with the deprecated methods can still be removed via `removeReceiveMessageListener` / `removeSendMessageListener` by passing the same `target.type` and `handler`.

