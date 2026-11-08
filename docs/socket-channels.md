# WebSocket channels

One socket per browser, with `type:key` channels inside (for example `order:42`). The client subscribes, a channel controller decides in `join`, methods decorated with `@SocketMessage` handle messages from the client, and `SocketPublisher` sends events from anywhere in the application to every instance through a broker (NATS or in-memory).

- Sources: `src/controllers/AbstractSocketEndpoint.ts`, `src/controllers/AbstractSocketController.ts`, `src/decorators/WebServer/{SocketEndpoint,SocketChannel,SocketMessage,RequiresAuth}.ts`, `src/infrastructure/Server/{SocketRegistry,SocketServer}.ts`, `src/infrastructure/Server/socket/` (`SocketHub`, `SocketProtocol`), `src/services/Socket/` (`SocketPublisher`, `NatsSocketBroker`, `MemorySocketBroker`), `src/client/socket/`
- Implementation traps: `REVIEW.md`
- A raw socket with your own protocol is still available through `@WebSocketListener(path)`, imported directly from `@invilite/framework/decorators/WebServer/WebSocketListener` (the `decorators/WebServer` index does not re-export it): the method receives `(ws, request)`.

## 1. Entry point

One class per socket, in a controllers directory (file name `*Controller.ts`, scanned by `WebServer`):

```ts
@SocketEndpoint('/ws')
export class AppSocketEndpoint extends AbstractSocketEndpoint<AppConnectionAttributes> {

    @RequiresAuth()
    public connect(request: IncomingMessage): AppConnectionAttributes | null {
        return {locale: (request as AuthorizedRequest).auth.locale ?? 'en'};
    }

    public disconnect(connection: SocketConnection<AppConnectionAttributes>): void {
    }
}
```

- `connect` runs before the upgrade, after the authentication middleware (`request.auth` as over HTTP). It returns the connection attributes (frozen, available in channels as `context.connection.attributes`) or `null`, which refuses the connection with 403.
- `@RequiresAuth()` on `connect`: a guest gets 401; `@RequiresAuth(roles)`: anyone without the roles gets 404.
- `disconnect` (optional): once after the connection is gone, after `leave` of all its channels, including those whose `join` was still in flight.
- The framework serves `GET <path>/session` (`{"user": id|null}`, never cached) and `GET <path>/client/<script>.js` with the browser client. Whatever gateway stands in front of the application must pass both paths through.

## 2. Channel controller

```ts
@SocketChannel('order')
export class OrderSocketController extends AbstractSocketController<AppConnectionAttributes> {

    public async join(context: SocketContext<AppConnectionAttributes>): Promise<boolean> {
        return await this.serviceContainer.get<OrderAccess>('OrderAccess').canView(context.connection.userId, Number(context.key));
    }

    public leave(context: SocketContext<AppConnectionAttributes>): void {
    }

    @SocketMessage('note')
    public note(context: SocketContext<AppConnectionAttributes>, data: unknown): void {
    }

    @SocketMessage('history')
    public history(context: SocketContext<AppConnectionAttributes>, data: unknown): Promise<HistoryPage> {
    }
}
```

- `@SocketChannel(type, {lossy?, endpoint?})`: the type matches `[a-z]{1,32}` and must not be `user`; `lossy` marks channels whose events may be skipped for a slow client (chat, counters; never notifications); `endpoint` names the endpoint path, needed only when there is more than one endpoint. Like every controller, the class receives the `ServiceContainer` as its first controller parameter (`this.serviceContainer`).
- `join` runs on every subscription (also after a reconnect): `true` subscribes, `false` refuses with `forbidden`, a thrown `SocketRefusalError` refuses with its code.
- `leave` (optional): exactly once after every `join` that returned `true` (unsubscribe, disconnect, server close), always after the `@SocketMessage` method that was still running finishes. Messages queued for a subscription that was left get `not_subscribed`.
- `context`: `connection` (`id`, `userId`, `attributes`), `channel` (`order:42`), `key` (`42`), and `state`, a mutable object of one connection in one channel, empty at `join`, gone after `leave`. One controller instance serves every connection, so per-connection state never goes into class fields.
- `@SocketMessage(type)`: the type matches `[a-z][A-Za-z0-9.]{0,63}`; the method signature is `(context, data: unknown)` and the controller validates the data. Returning `undefined` sends `ack`; any other value sends `ack` with data (the serialized frame may be up to 64 KiB, measured as the JSON string length in UTF-16 code units, not bytes). `@RequiresAuth(roles?)` on the method: a guest or a missing role gets `forbidden`.
- Messages of one connection in one channel run in order; different channels and different connections run in parallel.
- A channel only the server writes to needs just `join`.

## 3. Publishing

```ts
const publisher: SocketPublisher = new SocketPublisher(new NatsSocketBroker(natsConnection));
serviceContainer.register(publisher, 'SocketPublisher');

const webServer: WebServer = new WebServer(logger, {
    // ...
    socket: {publisher},
}, authService, tokenBlacklist);

publisher.publish('order:42', 'status.changed', {id: 7}, {except: context.connection.id});
publisher.toUser(42, 'notification', {id: 3});
```

- The application creates the publisher once, right after connecting to the broker, and registers it in the `ServiceContainer` as `'SocketPublisher'`. `WebServer` takes the broker and the subject prefix from it (`subjectPrefix`, default `ws`), so the hubs and the publisher cannot drift apart.
- `except` skips one connection, usually the sender's.
- Publish after the commit: nothing stored may depend on the event arriving. An event is at most 64 KiB, again measured in UTF-16 code units of the JSON payload, not bytes; an invalid channel or type name throws.
- `MemorySocketBroker` delivers inside one process: enough for a single instance and for tests. Several instances need a shared broker such as `NatsSocketBroker`.

## 4. The personal channel

The client subscribes to the bare `user`; the server maps it to the connection's own account, a guest gets `forbidden`. Only `publisher.toUser` writes there. A message from the client to `user` gets `unsupported`.

## 5. Errors

| What | The client gets |
|---|---|
| `join` returns `false` | `forbidden` |
| an unexpected exception in `join` | `forbidden` |
| `throw new SocketRefusalError('code')` in `join` or in a method | `code` (matches `[a-z][a-z0-9_]{0,31}`) |
| `ValidationError` (for example from `AbstractValidator.ensure`) | `invalid` |
| an unexpected exception in a `@SocketMessage` method, or a reply that cannot be sent | `failed` (the text stays in the log) |
| a message type without a method | `unsupported` |

Protocol mistakes get `bad_frame`, `bad_channel`, `unknown_channel`, `too_many_channels` and `rate_limited`.

A mistake in the socket classes at start (no `socket` in the options, an invalid type, two channels of one type, a channel without an endpoint, a wrong base class) stops the start: the `WebServer` constructor throws, naming the class.

## 6. Options and limits

`WebServerOptions.socket = {publisher, limits?}`. The default limits: frame 16 KiB (also the `maxPayload` of the socket), 32 channels per connection, a token bucket of 40 frames refilled at 10 per second, a 256 KiB lossy buffer (above it `lossy` events are skipped), a 1 MiB hard buffer (above it the connection closes with 4009), silence 75 s (4408), a sweep every 30 s (also session revocation: 4401).

## 7. Protocol

Version 1, JSON text frames. From the client: `sub`, `unsub`, `send` (`ch`, `t`, `d`, `id`), `ping`. From the server: `hello` (`user`), `subscribed`, `event` (`ch`, `t`, `d`), `ack` (`id`, optionally `d`), `error` (`code`, `ch`, `id`), `pong`. Close codes: 4401 session revoked, 4408 idle, 4009 slow client, 1009 frame too large, 1012 broker subscription lost (the client reconnects and subscribes afresh). Broker subjects: `<prefix>.<type>.<key>` and `<prefix>.user.<id>`.

## 8. Browser client

In a layout: `{{{socketClient '/ws'}}}`, a Handlebars helper registered by `WebServer` that returns a `SafeString`: the script tag with versioned client files and the page's account. The client scripts ship with the framework and are served by the endpoint itself, so nothing has to be copied at build time. Page API (`window.WebSocketEvents`):

- `subscribe(channel, onEvent, onError?, onSubscribed?)` returns an unsubscribe function; `onSubscribed` fires after every confirmed subscription, also after a reconnect: fetch the channel's initial data there,
- `send(channel, type, data)` returns a `Promise` with the `ack` data; without a reply it rejects after 10 s (the connection timer, so 10 s is the effective limit), and a 15 s fallback timer in the page facade settles requests a lost transport never answered,
- `onStatus(listener)` returns an unsubscribe function; the connection state is `idle`, `connecting`, `open` or `offline`.

One connection for all tabs through a `SharedWorker` (a separate worker per endpoint), without it a connection per tab; reconnecting uses a random backoff capped at 30 s, and the connection pings every 25 s.

## 9. Tests

Framework tests: `test/unit/Socket*.test.ts` (protocol, hub, publisher, decorators, browser client), `WebServerSocketScan.test.ts`, `SocketServerUpgrade.test.ts`. In an application: a `WebServer` with `socket: {publisher: new SocketPublisher(new MemorySocketBroker())}` and a `ws` client.
