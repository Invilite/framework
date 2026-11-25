# Channel presence - implementation plan (`docs/specs/2026-11-24-channel-presence-plan.md`)

> **What this is:** the task plan for channel presence. **Contains:** tasks with files, interfaces, tests and
> commands. **Dated and closed:** only a note that it is outdated may be added. Keep it short.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** accounts present in a socket channel across instances, with one `presenceChanged` call per change in the
cluster.

**Architecture:** `SocketPresence` gossips over the existing `SocketBroker` on `<prefix>.presence`; `SocketHub` feeds
it local enter/exit of presence channels; `SocketRegistry` wires controllers' `presenceChanged` to it.

**Tech Stack:** TypeScript ~5.5, jest + ts-jest, `MemorySocketBroker` in tests.

**Spec:** `docs/specs/2026-11-24-channel-presence-design.md`

## Global Constraints

- Nothing application-specific: neutral names in code, tests and docs (`room`, `order`, `example.com`).
- No new comments in any file, JSDoc included (`AGENTS.md`); explicit types, also on `const`; `public` keyword.
- Adding files under `src/` is a public API addition; no renames of existing files or exports.
- Defaults: `graceMs` 5 000, `heartbeatMs` 10 000, `expireMs` 30 000, `syncWaitMs` 1 000.
- Subject `<prefix>.presence`; guests (`userId === null`) never tracked.
- Release 0.3.0, published by the maintainer only (`AGENTS.md` "Release gate").

## Review Focus

1. A tab reload (exit then enter within `graceMs`) produces no `presenceChanged` at all.
2. Two tabs of one account on one instance: closing one is not a leave.
3. A rolling restart (`bye`, clients reconnect to another instance within the grace) produces no `left`.
4. An exception or a rejected promise in `presenceChanged` is logged and does not break later changes.
5. `stop()` clears every timer, so a stopped process exits (no live handles in jest `--detectOpenHandles`).

Each of these has a named test in Task 2 or Task 3.

---

### Task 1: API surface (option, hook, change type)

**Files:**
- Modify: `src/decorators/WebServer/SocketChannel.ts` (`SocketChannelOptions.presence?: boolean`,
  `SocketChannelDefinition.presence: boolean`)
- Create: `src/types/interfaces/SocketPresenceChange.ts`
- Modify: `src/controllers/AbstractSocketController.ts`
- Test: `test/unit/SocketDecorators.test.ts`

**Interfaces:**
- Produces: `interface SocketPresenceChange {joined: number[]; left: number[]}`;
  `AbstractSocketController.presenceChanged?(channel: string, change: SocketPresenceChange): void | Promise<void>`;
  `readSocketChannel(target)` returns `{type, lossy, endpoint, presence}`.

- [ ] **Step 1:** test `it("reads the presence option, off by default")`: `@SocketChannel('room', {presence: true})`
  → `readSocketChannel(...).presence === true`; `@SocketChannel('order')` → `false`.
- [ ] **Step 2:** `npx jest test/unit/SocketDecorators.test.ts` - FAIL (`presence` undefined).
- [ ] **Step 3:** implement the three changes.
- [ ] **Step 4:** the same command - PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5:** commit `Sockets: presence option on @SocketChannel and presenceChanged hook`.

### Task 2: `SocketPresence`

**Files:**
- Create: `src/services/Socket/SocketPresence.ts`
- Test: `test/unit/SocketPresence.test.ts`

**Interfaces:**
- Consumes: `SocketPublisher` (`broker`, `subjectPrefix`), `SocketPresenceChange`, `AbstractLogger`.
- Produces:
  ```ts
  export interface SocketPresenceOptions {graceMs?: number; heartbeatMs?: number; expireMs?: number; syncWaitMs?: number; now?: () => number; instanceId?: string}
  export type SocketPresenceHandler = (channel: string, change: SocketPresenceChange) => void | Promise<void>;
  export class SocketPresence {
      public static readonly DEFAULTS: Required<Omit<SocketPresenceOptions, 'now' | 'instanceId'>>;
      public readonly instanceId: string;
      public constructor(publisher: SocketPublisher, options?: SocketPresenceOptions);
      public register(type: string, handler: SocketPresenceHandler): void;
      public start(log: AbstractLogger): void;
      public stop(): void;
      public enter(channel: string, userId: number): void;
      public exit(channel: string, userId: number): void;
      public members(channel: string): Promise<number[]>;
  }
  ```
  `register` throws on a second handler for one type; `enter`/`exit` with a channel of an unregistered type throw.

Rules 1-6 of the design, §3. The message shape: `{v: 1, i, k, ch?, u?}`; malformed or own messages (`i ===
instanceId`) are ignored. Lowest live instance = smallest `instanceId` string among self and instances seen within
`expireMs`. Handler errors: `log.error('Presence change on "<channel>" failed:', error)`.

- [ ] **Step 1: tests** (helpers: `cluster(n)` creates `n` presences on one `MemorySocketBroker` with
  `instanceId` `a`, `b`, `c`, a recording handler per instance, `jest.useFakeTimers()`, `advance(ms)`):
  - `it("calls joined once in the cluster for the first subscription")` - `a.enter('room:1', 7)` after the sync
    window → handler of `a` got `{joined: [7], left: []}`, handlers of `b`/`c` nothing.
  - `it("ignores a second tab and a second instance")` - `a.enter` twice, `b.enter` once → one `joined` in total.
  - `it("does not blink on a reload within the grace")` - `exit` then `enter` after 4 000 ms → no call at all.
  - `it("keeps an account while another tab of it stays")` - two `enter`, one `exit`, advance 6 000 → no `left`.
  - `it("does not blink when the account moves to another instance within the grace")` - `a.exit`, after 2 000
    `b.enter`, advance 6 000 → no call on any instance.
  - `it("reports left after the grace on the last instance")` - `a.exit`, advance 5 001 → `a` got
    `{joined: [], left: [7]}`.
  - `it("hands left of a stopped instance to the lowest live instance")` - accounts 7 on `c` only; `c.stop()`;
    advance 5 001 → only `a` got `left: [7]`; with 7 also on `b` → nobody.
  - `it("treats a silent instance as gone after expireMs")` - `c` is built on a publisher whose broker wraps the shared
    one and can be switched off; switch it off (no `bye`); advance 30 001 → `a` gets `left` for `c`'s accounts.
  - `it("drops a stale entry of a live instance without a call")` - `b` holds 7; drop the `left` message of `b`
    on the wire (switchable broker); advance 30 001 → `members` on `a` has no 7, no handler called.
  - `it("lists members across instances, during grace too")` - `members('room:1')` → `[3, 7]` sorted, deduplicated.
  - `it("waits for the sync window before deciding a join")` - fresh `d` joins the cluster where `a` has 7;
    `d.enter('room:1', 7)` right after `start` → no `joined` anywhere.
  - `it("logs a failing handler and keeps working")` - handler throws once; the next change still arrives;
    `log.error` called with `'Presence change on "room:1" failed:'`.
  - `it("leaves no timers after stop")` - `stop()` on all → `jest.getTimerCount() === 0`.
- [ ] **Step 2:** `npx jest test/unit/SocketPresence.test.ts` - FAIL (module missing).
- [ ] **Step 3:** implement.
- [ ] **Step 4:** the same command - PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5:** commit `Sockets: SocketPresence across instances over the socket broker`.

### Task 3: Hub calls `enter` and `exit`

**Files:**
- Modify: `src/infrastructure/Server/socket/SocketHub.ts` (`SocketChannelHandlers.presence: boolean`,
  `SocketHubOptions.presence?: SocketPresence`)
- Test: `test/unit/SocketHub.test.ts`

**Interfaces:**
- Consumes: `SocketPresence.enter/exit` (Task 2).
- Produces: hub calls `enter(name, userId)` right after `join()` adds the member (only when `handlers.presence`,
  the hub has a presence and `userId !== null`), and `exit(name, userId)` in `leave()` for that subscription.

- [ ] **Step 1: tests** with a recording fake presence: `it("enters and exits presence channels for accounts")`
  (subscribe, unsubscribe, disconnect each produce one `enter`/`exit`), `it("never tracks guests, refused joins or
  channels without presence")`, `it("exits a subscription whose join finished after the disconnect")` (join resolves
  after `closed()` → neither `enter` nor `exit`).
- [ ] **Step 2:** `npx jest test/unit/SocketHub.test.ts` - FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** the same command - PASS (old tests unchanged).
- [ ] **Step 5:** commit `Sockets: hub reports presence channel enter and exit`.

### Task 4: Registry and options

**Files:**
- Modify: `src/infrastructure/Server/WebServerOptions.ts` (`WebServerSocketOptions.presence?: SocketPresence`)
- Modify: `src/infrastructure/Server/SocketRegistry.ts`
- Test: `test/unit/WebServerSocketScan.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: for a `presence: true` channel the registry passes `presence: true` to `hub.register`, calls
  `presence.register(type, (channel, change) => instance.presenceChanged?.(channel, change))`; hubs get
  `presence` in their options; `presence.start(logger)` in `serve`, `presence.stop()` in `close()` (once, also with
  several endpoints).

- [ ] **Step 1: tests:** `it("stops the start for a presence channel without options.socket.presence")` (message
  contains the class name and `needs WebServerOptions.socket.presence`); `it("refuses one presence channel type on
  two endpoints")`; `it("routes presenceChanged to the channel controller")` (a scanned `@SocketChannel('room',
  {presence: true})` with `presenceChanged` recording calls, driven through a `SocketPresence` on a
  `MemorySocketBroker` and fake timers).
- [ ] **Step 2:** `npx jest test/unit/WebServerSocketScan.test.ts` - FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `npm test` - all PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5:** commit `Sockets: presence wired through WebServer options and the registry`.

### Task 5: Documentation and release preparation

**Files:**
- Modify: `docs/socket-channels.md` (new section "Presence" after "Publishing": API, the example from the design §2,
  timing values, the races and the no-op rule for consumers, the `presenceChanged`-on-one-instance rule)
- Modify: `REVIEW.md` (entry: **Trap** `presenceChanged` runs on one instance; per-subscriber work there reaches
  only local clients → *Tell* `presenceChanged` that writes to local state or sockets instead of publishing →
  *Check* it publishes through `SocketPublisher` or writes shared storage; file `src/services/Socket/SocketPresence.ts`)
- Modify: `CHANGELOG.md` (`## [0.3.0] - <date>`, Added: `SocketPresence`, `presence` channel option,
  `presenceChanged`, `WebServerSocketOptions.presence`), `package.json` version `0.3.0`

- [ ] **Step 1:** write the three documents and bump the version.
- [ ] **Step 2:** release gate 1-3 from `AGENTS.md`: `npm run build && npm test`; `npm pack ./build --dry-run`
  lists only allowed files; both private-data scans reviewed by hand.
- [ ] **Step 3:** commit `Release 0.3.0: channel presence`; hand over to the maintainer for push, tag `v0.3.0` and
  `npm publish ./build`.
