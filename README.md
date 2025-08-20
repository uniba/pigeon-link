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

### `onReceiveMessage(target, handler, options?)`

```typescript
pigeon.onReceiveMessage<T>({
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

### `onSendMessage(target, handler, options?)`

```typescript
pigeon.onSendMessage<T>({
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

## Auto send pong on receive ping

Automatically replies with a pong message when `ping` is receivec.

