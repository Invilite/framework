# Channel presence - design (`docs/specs/2026-11-24-channel-presence-design.md`)

> **What this is:** the design of account presence in socket channels across application instances.
> **Contains:** the goal, the public API, the mechanism over the existing broker, timing values, failure cases,
> tests and documentation. **Dated and closed:** only a note that it is outdated may be added; the current state goes
> to `docs/socket-channels.md`. Keep it short.

Marks: **[M]** maintainer's decision, **[B]** designer's decision.

## 1. Why

A channel today knows only its local subscribers (`SocketHub`, one instance). Applications need "who is in this
channel" across all instances: a room list of people, a viewer count. `HeartbeatTracker` cannot list keys or report
a departure. The design note of socket channels lists presence under "later"; this is it.

**Anti-goals:** account ids sent to browsers by the framework (an application decides what it may show about an
account) [M]; a second transport next to the socket broker; a join/leave blink when a page reloads or a client
reconnects to another instance.

## 2. Public API

- `@SocketChannel(type, {presence: true})` - the hub tracks accounts subscribed to channels of this type. Guests
  (`userId === null`) are never tracked.
- `SocketPresence` (`src/services/Socket/SocketPresence.ts`), created by the application next to the publisher and
  registered in the `ServiceContainer` as `'SocketPresence'`:

  ```ts
  const presence: SocketPresence = new SocketPresence(publisher, {graceMs?, heartbeatMs?, expireMs?, syncWaitMs?});
  serviceContainer.register(presence, 'SocketPresence');
  new WebServer(logger, {socket: {publisher, presence}}, authService, tokenBlacklist);
  ```

  - `members(channel: string): Promise<number[]>` - accounts present on any instance, ascending; waits for the
    first sync window after the start.
  - It takes the broker and subject prefix from the publisher, like the hubs.
- `AbstractSocketController.presenceChanged?(channel: string, change: SocketPresenceChange): void | Promise<void>`
  with `SocketPresenceChange = {joined: number[]; left: number[]}` (`src/types/interfaces/SocketPresenceChange.ts`).
  Called **once per cluster**, on the instance where the change was decided; an exception is logged. The framework
  sends nothing to subscribers by itself: the controller publishes what it wants.
- A mistake stops the start (as with other socket classes): a `presence: true` channel without
  `options.socket.presence`, or the same presence channel type on two endpoints.

## 3. Mechanism [B]

Plain publish/subscribe on the existing `SocketBroker`, one subject `<prefix>.presence` (two segments, so it never
collides with channel subjects `<prefix>.<type>.<key>`). Every instance with a presence channel type subscribes to it
for its whole life. Each instance has a random `instanceId` (UUID) per process start.

Messages (JSON, `i` = sender instance):

| `k` | Data | When |
|---|---|---|
| `state` | `ch`, `u` (account ids) | every `heartbeatMs`, one per channel with local accounts; and in reply to `sync` |
| `alive` | - | every `heartbeatMs`, so an instance without accounts still counts as live |
| `joined` / `left` | `ch`, `u` | a local change (below) |
| `sync` | - | at start: every instance answers with its `state` messages |
| `bye` | - | at `stop()` |

State kept by each instance:

- **local:** channel → account → number of local subscriptions, plus accounts in local grace (`leavingAt`);
- **remote:** (instance, channel) → accounts and `seenAt`; **live instances:** instance → last message time.

Rules:

1. **Join.** A local count goes 0 → 1. If the account is in local grace: cancel the grace, nothing else. Otherwise
   publish `joined`; and if the account is in no remote entry and no holding set (rule 4), call `presenceChanged`
   with `joined` here. Join decisions wait until the first sync window (`syncWaitMs`) is over, so a fresh instance
   does not announce people the others already have.
2. **Leave.** A local count goes 1 → 0: the account enters local grace (`graceMs`) and stays in `state` messages.
   When the grace ends: remove it locally, publish `left`, and if the account is in no remote entry, call
   `presenceChanged` with `left` here.
3. **Remote messages** update the remote view only; they never call `presenceChanged`.
4. **An instance disappears** (`bye`, or no message for `expireMs`): its entries move to a holding set for `graceMs`
   (zero after an expiry, which is already late). Then the **lowest live `instanceId`** (including itself) calls
   `presenceChanged` with `left` for the held accounts present nowhere else; other instances only drop the entries.
   Clients of a stopped instance reconnect elsewhere within the grace, so a rolling restart does not blink.
5. **A single remote entry goes stale** (instance alive, but no `state` for that channel within `expireMs`, e.g. a
   lost `left` for its last account, since empty channels send no `state`): the entry is dropped and nothing is
   called. The owner already decided that change when its grace ended; only the remote view was wrong.
6. `members(channel)` = local (including grace) ∪ remote ∪ holding, deduplicated and sorted.

Accepted races: two instances deciding a join of one account at the same moment, or a reconnect message arriving
just after a grace check, can produce a duplicate `joined` or a `left` followed by `joined`. Consumers treat
`joined` of a present account and `left` of an absent one as no-ops; the next `members` call is the truth.

## 4. Values [B]

`graceMs` 5 000, `heartbeatMs` 10 000, `expireMs` 30 000 (three heartbeats), `syncWaitMs` 1 000; all overridable
(tests use small values or fake timers). Timers are `unref`ed. A `state` message carries one channel, so its size
grows with the accounts of one channel on one instance only.

## 5. Wiring

- `SocketRegistry` passes `presence` to every hub whose endpoint has a presence channel type, registers
  `presenceChanged` of each such controller with `presence.register(type, handler)` and starts/stops the presence
  with the hubs (`start()` subscribes and sends `sync`; `stop()` sends `bye` and unsubscribes).
- `SocketHub` calls `presence.enter(channel, userId)` after a successful join of a presence channel and
  `presence.exit(channel, userId)` in `leave` of that subscription (both synchronous; the presence does its own
  timing).
- `MemorySocketBroker` is enough for tests with several `SocketPresence` objects, each standing for an instance.

## 6. Tests

Unit (`test/unit/SocketPresence.test.ts`, two or three presences on one `MemorySocketBroker`, jest fake timers):
first join calls the handler once in the cluster; a second tab or a second instance does not; a reload within the
grace does not blink; a move to another instance within the grace does not blink; leave after the grace on the last
instance; `bye` and expiry hand the `left` to the lowest live instance only; `members` across instances and during
grace; a stale entry of a live instance (lost `left`) disappears from `members` without a call; guests ignored; a fresh instance waits for sync before deciding joins. Hub and registry: `enter`/`exit`
around join, refused join, unsubscribe and disconnect; start fails without `options.socket.presence`.

## 7. Documentation and release

`docs/socket-channels.md` gains a "Presence" section (API, timing, the races above); `REVIEW.md` an entry for
"`presenceChanged` runs on one instance only - never publish from `enter`/`exit` paths". Release 0.3.0 (new
feature = minor), `CHANGELOG.md` entry, tag `v0.3.0`; the maintainer publishes.

**Note 2026-11-26: implementation differs.** The current state is in `docs/socket-channels.md` section 4. The grace-end
`left` (rule 2) also checks the holding sets, not only remote entries. The reply to `sync` carries `alive` too. A
stale channel entry (rule 5) is dropped only for an instance that sent `alive` within 1.5 x `heartbeatMs`; otherwise it
waits for the instance expiry. The holding-set release (rule 4) is decided from a candidate snapshot instead of the
lowest live instance at release time: the survivor itself and the live instances it first heard no later than the
departed instance's last message (`bye` included); the lowest candidate still live decides, and an instance started
later is never a candidate. An instance expired by silence and heard again within 10 x `expireMs` makes every observer
call `joined` for its accounts present nowhere else in the observer's view (partition heal), so rule 3 no longer holds
for that rebuild window. `members()` resolves with `[]` after `stop()` and gives a rejected promise for a channel it
cannot track; `enter`/`exit` throw synchronously, also on an account id that is not a positive safe integer.
