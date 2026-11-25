# WebSocket channels

One socket per browser, with `type:key` channels inside (for example `order:42`). The client subscribes, a channel controller decides in `join`, methods decorated with `@SocketMessage` handle messages from the client, and `SocketPublisher` sends events from anywhere in the application to every instance through a broker (NATS or in-memory).

- Sources: `src/controllers/AbstractSocketEndpoint.ts`, `src/controllers/AbstractSocketController.ts`, `src/decorators/WebServer/{SocketEndpoint,SocketChannel,SocketMessage,RequiresAuth}.ts`, `src/infrastructure/Server/{SocketRegistry,SocketServer}.ts`, `src/infrastructure/Server/socket/` (`SocketHub`, `SocketProtocol`), `src/services/Socket/` (`SocketPublisher`, `SocketPresence`, `NatsSocketBroker`, `MemorySocketBroker`), `src/client/socket/`
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

- `@SocketChannel(type, {lossy?, presence?, endpoint?})`: the type matches `[a-z]{1,32}` and must not be `user`; `lossy` marks channels whose events may be skipped for a slow client (chat, counters; never notifications); `presence` tracks the accounts in channels of this type (section 4); `endpoint` names the endpoint path, needed only when there is more than one endpoint. Like every controller, the class receives the `ServiceContainer` as its first controller parameter (`this.serviceContainer`).
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

## 4. Presence

Which accounts are in a channel, across all instances: a room list, a viewer count. The framework tracks and decides; what is shown to browsers stays with the application (it never sends account ids by itself).

```ts
@SocketChannel('room', {presence: true})
export class RoomSocketController extends AbstractSocketController<AppConnectionAttributes> {

    public async join(context: SocketContext<AppConnectionAttributes>): Promise<boolean> {
        return context.connection.userId !== null;
    }

    public async presenceChanged(channel: string, change: SocketPresenceChange): Promise<void> {
        this.serviceContainer.get<SocketPublisher>('SocketPublisher').publish(channel, 'presence.changed', {
            joined: await this.publicKeys(change.joined),
            left: await this.publicKeys(change.left),
        });
    }
}

const presence: SocketPresence = new SocketPresence(publisher, {graceMs: 5000});
serviceContainer.register(presence, 'SocketPresence');

const webServer: WebServer = new WebServer(logger, {
    // ...
    socket: {publisher, presence},
}, authService, tokenBlacklist);

const accounts: number[] = await presence.members('room:42');
```

- `@SocketChannel(type, {presence: true})`: after every successful `join` the hub counts the account in the channel, and `leave` uncounts it. Guests (`userId === null`) are never tracked. Several tabs or connections of one account count as one member.
- `SocketPresence` takes the broker and the subject prefix from the publisher, like the hubs; create it next to the publisher and register it as `'SocketPresence'`. `WebServer` starts and stops it with the sockets.
- `members(channel)` resolves with the account ids present on any instance, ascending, including accounts in a grace period. Until the first sync window after the start is over it waits, so it never answers from an empty view. After `stop()` it resolves with `[]` at once (a call still waiting for the sync window too). A channel it cannot track (invalid, personal, or of a type without presence) gives a rejected promise, not a synchronous throw.
- `enter(channel, userId)` and `exit(channel, userId)` (called by the hub) throw synchronously on such a channel, and on an account id that is not a positive safe integer.
- `presenceChanged(channel, change)` (optional, on the channel controller) gets `SocketPresenceChange = {joined: number[]; left: number[]}`. An exception, or a rejected promise, is logged. The account ids are for the server: `publicKeys` in the example stands for the application's own mapping to what it may show about an account; publishing only a count is the other safe choice.
- `joined` is called when an account enters a channel it was in nowhere in the cluster; `left` when it is gone everywhere, after the grace period. A second tab, a second instance, a page reload and a reconnect to another instance within `graceMs` call nothing.
- A start error: a `presence: true` channel without `options.socket.presence`, or one presence channel type on two endpoints.

`presenceChanged` runs once per cluster, on the instance that decided the change, so a client connected to another instance learns about it only if the controller publishes through `SocketPublisher` (or writes shared storage). Work done there on local state or local sockets reaches only the clients of that instance.

Instances talk over the existing broker, on one subject `<prefix>.presence`, with JSON messages that carry a protocol version and a random instance id (a new one at every process start): `state` (the accounts of one channel on the sender), `joined` and `left` (a local change), `alive`, `sync` (a fresh instance asks for state) and `bye` (at `stop()`). `members` is the union of local, remote and held accounts.

| Option | Default | Meaning |
|---|---|---|
| `graceMs` | 5000 | an account that left its last local subscription stays present for this long; also how long accounts of a stopped instance are held |
| `heartbeatMs` | 10000 | `alive` and one `state` per channel with local accounts, at this interval |
| `expireMs` | 30000 | an instance silent for this long is gone; also the lifetime of a channel entry |
| `syncWaitMs` | 1000 | after the start the instance only listens; its joins are decided after this window |

`instanceId` can be set too (tests); it must be unique per process, and the default is a random UUID. Timers do not keep the process alive.

How the cases resolve:

- An instance that stops (`bye`) or goes silent (`expireMs`) has its accounts held for `graceMs` (none after an expiry, which is already late). Then one instance calls `left` for the held accounts present nowhere else; the others only drop them. An account is also kept if it is in a holding set of another stopped instance, so a rolling restart does not blink.
- Who decides a hold: when an instance departs, every survivor fixes the candidates: itself and the live instances it first heard no later than the departed instance's last message (`bye` or final state). When the hold ends, the lowest candidate that is still live decides. An instance first heard after that message is not a candidate, because it has not seen the departed instance's accounts.
- The reply to `sync` carries `alive` too, so all instances agree on who is live.
- A channel entry of an instance that stays alive but stops reporting it (a lost `left`) is dropped without a call, but only while that instance sent `alive` within 1.5 x `heartbeatMs`; otherwise it waits for the instance expiry, which hands every channel over as above.
- A partition longer than `expireMs` gives a `left` on both sides for the accounts of the other. An instance that was expired by silence (not `bye`) and is heard again within 10 x `expireMs` is rebuilt for 1.5 x `heartbeatMs`: for every account it reports that is present nowhere else in its own view (local, other instances, holding sets), each observer calls `joined`. Every observer does it, not only one, because the `left` was decided while the sides could not hear each other.
- After the broker reports the subscription `failed` (also for a subscription that stays open, for example when delivery threw), or refuses `subscribe`, the presence unsubscribes, then subscribes and syncs again on the next heartbeat. Publish and subscribe errors are logged.
- A message with another protocol version is ignored, with one `warning` per sender instance.

Accepted races. Consumers treat `joined` of an account already present, and `left` of an absent one, as no-ops; `members()` is the truth.

- Two instances deciding the join of one account at the same moment: two `joined`.
- A reconnect message arriving just after a grace check: `left`, then `joined`.
- A fresh instance does not see the holding sets of the others, so a client of a just stopped instance that reconnects to a brand-new instance can produce a duplicate `joined`.
- A newcomer whose first message reaches a survivor before the departed instance's last message, within broker latency, becomes a candidate without having heard that instance's state, so one `left` can be lost. The next `members()` read heals it.
- Another instance's grace ending inside a fresh instance's sync window can produce `left` and then `joined`.
- The last subscriptions of one account on two instances ending within broker latency: each grace ends while the other instance's entry is still there, so the `left` can be lost. It does not heal by itself; `members()` is right once the `left` messages arrive.
- A healed partition (above): a duplicate `joined` from every observer, and from the returning instance's own joins decided during the rebuild window.

## 5. The personal channel

The client subscribes to the bare `user`; the server maps it to the connection's own account, a guest gets `forbidden`. Only `publisher.toUser` writes there. A message from the client to `user` gets `unsupported`.

## 6. Errors

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

## 7. Options and limits

`WebServerOptions.socket = {publisher, presence?, limits?}`; `presence` is required when any channel sets `presence: true`. The default limits: frame 16 KiB (also the `maxPayload` of the socket), 32 channels per connection, a token bucket of 40 frames refilled at 10 per second, a 256 KiB lossy buffer (above it `lossy` events are skipped), a 1 MiB hard buffer (above it the connection closes with 4009), silence 75 s (4408), a sweep every 30 s (also session revocation: 4401).

## 8. Protocol

Version 1, JSON text frames. From the client: `sub`, `unsub`, `send` (`ch`, `t`, `d`, `id`), `ping`. From the server: `hello` (`user`), `subscribed`, `event` (`ch`, `t`, `d`), `ack` (`id`, optionally `d`), `error` (`code`, `ch`, `id`), `pong`. Close codes: 4401 session revoked, 4408 idle, 4009 slow client, 1009 frame too large, 1012 broker subscription lost (the client reconnects and subscribes afresh). Broker subjects: `<prefix>.<type>.<key>` and `<prefix>.user.<id>`.

## 9. Browser client

In a layout: `{{{socketClient '/ws'}}}`, a Handlebars helper registered by `WebServer` that returns a `SafeString`: the script tag with versioned client files and the page's account. The client scripts ship with the framework and are served by the endpoint itself, so nothing has to be copied at build time. Page API (`window.WebSocketEvents`):

- `subscribe(channel, onEvent, onError?, onSubscribed?)` returns an unsubscribe function; `onSubscribed` fires after every confirmed subscription, also after a reconnect: fetch the channel's initial data there,
- `send(channel, type, data)` returns a `Promise` with the `ack` data; without a reply it rejects after 10 s (the connection timer, so 10 s is the effective limit), and a 15 s fallback timer in the page facade settles requests a lost transport never answered,
- `onStatus(listener)` returns an unsubscribe function; the connection state is `idle`, `connecting`, `open` or `offline`.

One connection for all tabs through a `SharedWorker` (a separate worker per endpoint), without it a connection per tab; reconnecting uses a random backoff capped at 30 s, and the connection pings every 25 s.

## 10. Tests

Framework tests: `test/unit/Socket*.test.ts` (protocol, hub, publisher, presence, decorators, browser client), `WebServerSocketScan.test.ts`, `SocketServerUpgrade.test.ts`. In an application: a `WebServer` with `socket: {publisher: new SocketPublisher(new MemorySocketBroker())}` and a `ws` client.
