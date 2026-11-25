import {Logger} from "@invilite/logger";
import {SocketChannelHandlers, SocketHub, SocketHubConnection, SocketMessageHandler, SocketPeer} from "../../src/infrastructure/Server/socket/SocketHub";
import {MemorySocketBroker} from "../../src/services/Socket/MemorySocketBroker";
import {SocketPublisher} from "../../src/services/Socket/SocketPublisher";
import {SocketRefusalError} from "../../src/errors/ApplicationError/SocketRefusalError";
import {ValidationError} from "../../src/errors/ValidationError";
import {SocketConnection} from "../../src/types/interfaces/SocketConnection";
import {SocketContext} from "../../src/types/interfaces/SocketContext";

class FakePeer implements SocketPeer {
    public readonly frames: Record<string, unknown>[] = [];
    public closedWith: {code: number; reason: string} | null = null;
    public bufferedAmount: number = 0;

    public send(frame: string): void {
        this.frames.push(JSON.parse(frame) as Record<string, unknown>);
    }

    public close(code: number, reason: string): void {
        this.closedWith = {code, reason};
    }

    public last(): Record<string, unknown> | undefined {
        return this.frames[this.frames.length - 1];
    }
}

interface Client {
    peer: FakePeer;
    hub: SocketHubConnection;
    connection: SocketConnection;
}

/** Lets pending join() and message promises settle. */
const flush = (): Promise<void> => new Promise<void>((resolve: () => void): void => {
    setImmediate(resolve);
});

function message(handle: (context: SocketContext, data: unknown) => unknown, auth: {requiresLogin?: boolean; roles?: string[]} = {}): SocketMessageHandler {
    return {requiresLogin: auth.requiresLogin ?? false, roles: auth.roles ?? null, handle};
}

describe("socket hub", () => {
    let broker: MemorySocketBroker;
    let hub: SocketHub;
    let publisher: SocketPublisher;
    let now: number;
    let log: Logger;
    let nextId: number;
    let events: string[];
    let received: unknown[];
    let disconnected: string[];
    let presenceCalls: string[];

    const orders: SocketChannelHandlers = {
        lossy: true,
        presence: false,
        join: (context: SocketContext): boolean => {
            events.push(`join ${context.channel} ${context.connection.id}`);
            if (context.key === '99') {
                throw new SocketRefusalError('blocked', 'Blocked in this room');
            }
            if (context.key === '98') {
                throw new Error('database down');
            }

            return context.key !== '13';
        },
        leave: (context: SocketContext): void => {
            events.push(`leave ${context.channel} ${context.connection.id}`);
        },
        messages: new Map<string, SocketMessageHandler>([
            ['notes.message', message((context: SocketContext, data: unknown): void => {
                if (context.connection.userId === null) {
                    throw new SocketRefusalError('login_required');
                }
                received.push({user: context.connection.userId, key: context.key, data});
            })],
            ['notes.history', message((): unknown => ({messages: [1, 2]}))],
            ['notes.count', message((context: SocketContext): number => {
                context.state.count = Number(context.state.count ?? 0) + 1;
                return Number(context.state.count);
            })],
            ['notes.cycle', message((): unknown => {
                const cycle: Record<string, unknown> = {};
                cycle.self = cycle;
                return cycle;
            })],
            ['notes.huge', message((): string => 'a'.repeat(70 * 1024))],
            ['notes.throws', message((): never => {
                throw 'not an error';
            })],
            ['notes.invalid', message((): never => {
                throw new ValidationError('Validation failed', []);
            })],
            ['notes.members', message((): string => 'members', {requiresLogin: true})],
            ['notes.admin', message((): string => 'admin', {roles: ['admin']})],
        ]),
    };

    function connect(userId: number | null, role: string | null = null, stillValid: (() => boolean) | null = null): Client {
        const peer: FakePeer = new FakePeer();
        const connection: SocketConnection = {id: `c${nextId++}`, userId, attributes: {}};
        return {peer, connection, hub: hub.attach(peer, connection, role, stillValid)};
    }

    beforeEach(() => {
        now = 1_000_000;
        nextId = 1;
        events = [];
        received = [];
        disconnected = [];
        presenceCalls = [];
        log = new Logger();
        broker = new MemorySocketBroker();
        publisher = new SocketPublisher(broker);
        hub = new SocketHub({
            broker,
            subjectPrefix: 'ws',
            log,
            now: (): number => now,
            presence: {
                enter: (channel: string, userId: number): void => {
                    presenceCalls.push(`enter ${channel} ${userId}`);
                },
                exit: (channel: string, userId: number): void => {
                    presenceCalls.push(`exit ${channel} ${userId}`);
                },
            },
            disconnect: (connection: SocketConnection): void => {
                disconnected.push(connection.id);
                events.push(`disconnect ${connection.id}`);
            },
        });
        hub.register('order', orders);
    });

    it("greets a connection with the account it is connected as", () => {
        expect(connect(42).peer.frames).toEqual([{op: 'hello', v: 1, user: 42}]);
        expect(connect(null).peer.frames).toEqual([{op: 'hello', v: 1, user: null}]);
    });

    it("subscribes to the broker only while a local connection is in the channel, and delivers one event to each", async () => {
        const a: Client = connect(1);
        const b: Client = connect(null);
        a.hub.receive('{"op":"sub","ch":"order:12"}');
        b.hub.receive('{"op":"sub","ch":"order:12"}');
        await flush();

        expect(a.peer.last()).toEqual({op: 'subscribed', ch: 'order:12'});
        expect(broker.subjects()).toEqual(['ws.order.12']);

        publisher.publish('order:12', 'watchers', {count: 2});
        expect(a.peer.last()).toEqual({op: 'event', ch: 'order:12', t: 'watchers', d: {count: 2}});
        expect(b.peer.last()).toEqual({op: 'event', ch: 'order:12', t: 'watchers', d: {count: 2}});

        a.hub.receive('{"op":"unsub","ch":"order:12"}');
        expect(broker.subjects()).toEqual(['ws.order.12']);
        b.hub.closed();
        expect(broker.subjects()).toEqual([]);
        expect(hub.stats()).toEqual({connections: 1, channels: 0});
    });

    it("maps the personal channel to the connection's own account and refuses it to a guest", async () => {
        const mine: Client = connect(7);
        const other: Client = connect(8);
        const guest: Client = connect(null);
        for (const client of [mine, other, guest]) {
            client.hub.receive('{"op":"sub","ch":"user"}');
        }
        await flush();

        publisher.toUser(7, 'notification', {id: 1});
        expect(mine.peer.last()).toEqual({op: 'event', ch: 'user', t: 'notification', d: {id: 1}});
        expect(other.peer.last()).toEqual({op: 'subscribed', ch: 'user'});
        expect(guest.peer.last()).toEqual({op: 'error', code: 'forbidden', ch: 'user'});

        mine.hub.receive('{"op":"send","ch":"user","t":"notes.message","d":null,"id":"1"}');
        expect(mine.peer.last()).toEqual({op: 'error', code: 'unsupported', ch: 'user', id: '1'});
    });

    it("refuses channels the controller does not allow, with its own code when it gives one, unknown types and malformed names", async () => {
        const client: Client = connect(1);
        client.hub.receive('{"op":"sub","ch":"order:13"}');
        client.hub.receive('{"op":"sub","ch":"order:99"}');
        client.hub.receive('{"op":"sub","ch":"order:98"}');
        client.hub.receive('{"op":"sub","ch":"wallet:1"}');
        client.hub.receive('{"op":"sub","ch":"order:a.b"}');
        client.hub.receive('{"op":"sub","ch":"user:1"}');
        await flush();

        expect(client.peer.frames.slice(1, 4)).toEqual([
            {op: 'error', code: 'unknown_channel', ch: 'wallet:1'},
            {op: 'error', code: 'bad_channel', ch: 'order:a.b'},
            {op: 'error', code: 'bad_channel', ch: 'user:1'},
        ]);
        expect(client.peer.frames.slice(4)).toHaveLength(3);
        expect(client.peer.frames.slice(4)).toEqual(expect.arrayContaining([
            {op: 'error', code: 'forbidden', ch: 'order:13'},
            {op: 'error', code: 'blocked', ch: 'order:99'},
            {op: 'error', code: 'forbidden', ch: 'order:98'},
        ]));
        expect(broker.subjects()).toEqual([]);
        expect(events.filter((event: string): boolean => event.startsWith('leave'))).toEqual([]);
    });

    it("leaves right away a channel unsubscribed while its join was pending", async () => {
        const client: Client = connect(1);
        client.hub.receive('{"op":"sub","ch":"order:12"}');
        client.hub.receive('{"op":"unsub","ch":"order:12"}');
        await flush();

        expect(broker.subjects()).toEqual([]);
        expect(client.peer.frames).toHaveLength(1);
        expect(events).toEqual(['join order:12 c1', 'leave order:12 c1']);
    });

    it("calls leave once for every allowed join and disconnect once after all of them", async () => {
        const client: Client = connect(1);
        client.hub.receive('{"op":"sub","ch":"order:12"}');
        client.hub.receive('{"op":"sub","ch":"order:14"}');
        client.hub.receive('{"op":"sub","ch":"order:13"}');
        await flush();
        client.hub.receive('{"op":"unsub","ch":"order:12"}');
        client.hub.closed();
        client.hub.closed();
        await flush();

        expect(events).toEqual([
            'join order:12 c1', 'join order:14 c1', 'join order:13 c1',
            'leave order:12 c1', 'leave order:14 c1', 'disconnect c1',
        ]);
        expect(disconnected).toEqual(['c1']);
    });

    it("passes a message to the controller and answers with ack, data or the refusal code", async () => {
        const member: Client = connect(5);
        const guest: Client = connect(null);
        member.hub.receive('{"op":"sub","ch":"order:12"}');
        guest.hub.receive('{"op":"sub","ch":"order:12"}');
        await flush();

        member.hub.receive('{"op":"send","ch":"order:12","t":"notes.message","d":{"text":"hi"},"id":"1"}');
        member.hub.receive('{"op":"send","ch":"order:12","t":"notes.history","d":null,"id":"2"}');
        member.hub.receive('{"op":"send","ch":"order:12","t":"notes.unknown","d":null,"id":"3"}');
        member.hub.receive('{"op":"send","ch":"order:14","t":"notes.message","d":null,"id":"4"}');
        guest.hub.receive('{"op":"send","ch":"order:12","t":"notes.message","d":{"text":"hi"},"id":"5"}');
        await flush();

        expect(received).toEqual([{user: 5, key: '12', data: {text: 'hi'}}]);
        expect(member.peer.frames.slice(2)).toEqual([
            {op: 'error', code: 'unsupported', ch: 'order:12', id: '3'},
            {op: 'error', code: 'not_subscribed', ch: 'order:14', id: '4'},
            {op: 'ack', id: '1'},
            {op: 'ack', id: '2', d: {messages: [1, 2]}},
        ]);
        expect(guest.peer.last()).toEqual({op: 'error', code: 'login_required', ch: 'order:12', id: '5'});
    });

    it("keeps state per connection and channel, empty again after the next join", async () => {
        const client: Client = connect(5);
        const other: Client = connect(6);
        client.hub.receive('{"op":"sub","ch":"order:12"}');
        other.hub.receive('{"op":"sub","ch":"order:12"}');
        await flush();
        client.hub.receive('{"op":"send","ch":"order:12","t":"notes.count","d":null,"id":"1"}');
        client.hub.receive('{"op":"send","ch":"order:12","t":"notes.count","d":null,"id":"2"}');
        other.hub.receive('{"op":"send","ch":"order:12","t":"notes.count","d":null,"id":"3"}');
        await flush();
        client.hub.receive('{"op":"unsub","ch":"order:12"}');
        client.hub.receive('{"op":"sub","ch":"order:12"}');
        await flush();
        client.hub.receive('{"op":"send","ch":"order:12","t":"notes.count","d":null,"id":"4"}');
        await flush();

        expect(client.peer.frames.filter((frame: Record<string, unknown>): boolean => frame.op === 'ack'))
            .toEqual([{op: 'ack', id: '1', d: 1}, {op: 'ack', id: '2', d: 2}, {op: 'ack', id: '4', d: 1}]);
        expect(other.peer.last()).toEqual({op: 'ack', id: '3', d: 1});
    });

    it("handles the messages of one connection in one channel in order, one at a time", async () => {
        const order: string[] = [];
        let release: () => void = (): void => undefined;
        hub.register('room', {
            lossy: false,
            presence: false,
            join: (): boolean => true,
            leave: (): void => undefined,
            messages: new Map<string, SocketMessageHandler>([
                ['slow', message(async (): Promise<void> => {
                    order.push('slow start');
                    await new Promise<void>((resolve: () => void): void => {
                        release = resolve;
                    });
                    order.push('slow end');
                })],
                ['fast', message((): void => {
                    order.push('fast');
                })],
            ]),
        });
        const client: Client = connect(1);
        client.hub.receive('{"op":"sub","ch":"room:1"}');
        client.hub.receive('{"op":"sub","ch":"room:2"}');
        await flush();

        client.hub.receive('{"op":"send","ch":"room:1","t":"slow","d":null,"id":"1"}');
        client.hub.receive('{"op":"send","ch":"room:1","t":"fast","d":null,"id":"2"}');
        client.hub.receive('{"op":"send","ch":"room:2","t":"fast","d":null,"id":"3"}');
        await flush();
        expect(order).toEqual(['slow start', 'fast']);

        release();
        await flush();
        expect(order).toEqual(['slow start', 'fast', 'slow end', 'fast']);
        expect(client.peer.frames.filter((frame: Record<string, unknown>): boolean => frame.op === 'ack').map((frame: Record<string, unknown>): unknown => frame.id))
            .toEqual(['3', '1', '2']);
    });

    it("stops the queue of a connection that closes while a message is still handled", async () => {
        const handled: string[] = [];
        let release: () => void = (): void => undefined;
        hub.register('room', {
            lossy: false,
            presence: false,
            join: (): boolean => true,
            leave: (context: SocketContext): void => {
                events.push(`leave ${context.channel}`);
            },
            messages: new Map<string, SocketMessageHandler>([
                ['slow', message(async (): Promise<string> => {
                    handled.push('slow');
                    await new Promise<void>((resolve: () => void): void => {
                        release = resolve;
                    });
                    return 'late';
                })],
                ['next', message((): void => {
                    handled.push('next');
                })],
            ]),
        });
        const client: Client = connect(1);
        client.hub.receive('{"op":"sub","ch":"room:1"}');
        await flush();
        const before: number = client.peer.frames.length;

        client.hub.receive('{"op":"send","ch":"room:1","t":"slow","d":null,"id":"1"}');
        client.hub.receive('{"op":"send","ch":"room:1","t":"next","d":null,"id":"2"}');
        await flush();
        client.hub.closed();
        release();
        await flush();

        expect(handled).toEqual(['slow']);
        expect(client.peer.frames).toHaveLength(before);
        expect(events.filter((event: string): boolean => event === 'leave room:1')).toHaveLength(1);
        expect(disconnected).toEqual(['c1']);
    });

    it("answers failed for a reply that cannot be sent and for unexpected errors, invalid for validation errors", async () => {
        const client: Client = connect(1);
        client.hub.receive('{"op":"sub","ch":"order:12"}');
        await flush();
        const errors: jest.SpyInstance = jest.spyOn(log, 'error');

        client.hub.receive('{"op":"send","ch":"order:12","t":"notes.cycle","d":null,"id":"1"}');
        client.hub.receive('{"op":"send","ch":"order:12","t":"notes.huge","d":null,"id":"2"}');
        client.hub.receive('{"op":"send","ch":"order:12","t":"notes.throws","d":null,"id":"3"}');
        client.hub.receive('{"op":"send","ch":"order:12","t":"notes.invalid","d":null,"id":"4"}');
        await flush();

        expect(client.peer.frames.slice(2)).toEqual([
            {op: 'error', code: 'failed', ch: 'order:12', id: '1'},
            {op: 'error', code: 'failed', ch: 'order:12', id: '2'},
            {op: 'error', code: 'failed', ch: 'order:12', id: '3'},
            {op: 'error', code: 'invalid', ch: 'order:12', id: '4'},
        ]);
        expect(errors).toHaveBeenCalledTimes(3);
        expect(client.peer.closedWith).toBeNull();
    });

    it("refuses a method behind @RequiresAuth to a guest and one behind a role to an account without it", async () => {
        const guest: Client = connect(null);
        const user: Client = connect(1, 'user');
        const admin: Client = connect(2, 'admin');
        for (const client of [guest, user, admin]) {
            client.hub.receive('{"op":"sub","ch":"order:12"}');
        }
        await flush();
        for (const client of [guest, user, admin]) {
            client.hub.receive('{"op":"send","ch":"order:12","t":"notes.members","d":null,"id":"1"}');
            client.hub.receive('{"op":"send","ch":"order:12","t":"notes.admin","d":null,"id":"2"}');
        }
        await flush();

        expect(guest.peer.frames.slice(2)).toEqual([
            {op: 'error', code: 'forbidden', ch: 'order:12', id: '1'},
            {op: 'error', code: 'forbidden', ch: 'order:12', id: '2'},
        ]);
        expect(user.peer.frames.slice(2)).toEqual([
            {op: 'ack', id: '1', d: 'members'},
            {op: 'error', code: 'forbidden', ch: 'order:12', id: '2'},
        ]);
        expect(admin.peer.frames.slice(2)).toEqual([
            {op: 'ack', id: '1', d: 'members'},
            {op: 'ack', id: '2', d: 'admin'},
        ]);
    });

    it("skips the connection a publication excludes", async () => {
        const sender: Client = connect(1);
        const other: Client = connect(2);
        sender.hub.receive('{"op":"sub","ch":"order:12"}');
        other.hub.receive('{"op":"sub","ch":"order:12"}');
        await flush();
        const before: number = sender.peer.frames.length;

        publisher.publish('order:12', 'notes.editing', {label: 'a'}, {except: sender.connection.id});

        expect(sender.peer.frames).toHaveLength(before);
        expect(other.peer.last()).toEqual({op: 'event', ch: 'order:12', t: 'notes.editing', d: {label: 'a'}});
    });

    it("answers pings and rejects frames that are not the protocol", () => {
        const client: Client = connect(1);
        client.hub.receive('{"op":"ping"}');
        client.hub.receive('not json');
        client.hub.receive('{"op":"jump"}');

        expect(client.peer.frames.slice(1)).toEqual([
            {op: 'pong'},
            {op: 'error', code: 'bad_frame'},
            {op: 'error', code: 'bad_frame'},
        ]);
    });

    it("limits the frame rate and closes a connection that sends an oversized frame", () => {
        const flood: Client = connect(1);
        for (let i = 0; i < 41; i++) {
            flood.hub.receive('{"op":"ping"}');
        }
        expect(flood.peer.last()).toEqual({op: 'error', code: 'rate_limited'});
        now += 1000;
        flood.hub.receive('{"op":"ping"}');
        expect(flood.peer.last()).toEqual({op: 'pong'});

        const big: Client = connect(1);
        big.hub.receive(`{"op":"ping","x":"${'a'.repeat(17 * 1024)}"}`);
        expect(big.peer.closedWith).toEqual({code: 1009, reason: 'Frame too large'});
    });

    it("skips lossy events for a slow client and drops a client that cannot keep up at all", async () => {
        const client: Client = connect(1);
        client.hub.receive('{"op":"sub","ch":"order:12"}');
        client.hub.receive('{"op":"sub","ch":"user"}');
        await flush();
        const before: number = client.peer.frames.length;

        client.peer.bufferedAmount = 300 * 1024;
        publisher.publish('order:12', 'watchers', {count: 1});
        publisher.toUser(1, 'notification', {id: 1});
        expect(client.peer.frames.slice(before)).toEqual([{op: 'event', ch: 'user', t: 'notification', d: {id: 1}}]);

        client.peer.bufferedAmount = 2 * 1024 * 1024;
        publisher.toUser(1, 'notification', {id: 2});
        expect(client.peer.closedWith).toEqual({code: 4009, reason: 'Slow consumer'});
        expect(broker.subjects()).toEqual([]);
    });

    it("closes silent connections and connections whose session was revoked", () => {
        let valid: boolean = true;
        const quiet: Client = connect(1);
        const talking: Client = connect(2, null, (): boolean => valid);

        now += 60_000;
        talking.hub.receive('{"op":"ping"}');
        now += 20_000;
        hub.sweep();
        expect(quiet.peer.closedWith).toEqual({code: 4408, reason: 'Idle'});
        expect(talking.peer.closedWith).toBeNull();

        valid = false;
        hub.sweep();
        expect(talking.peer.closedWith).toEqual({code: 4401, reason: 'Session revoked'});
        expect(hub.stats().connections).toEqual(0);
    });

    it("drops malformed broker payloads", async () => {
        const client: Client = connect(1);
        client.hub.receive('{"op":"sub","ch":"order:12"}');
        await flush();
        const before: number = client.peer.frames.length;

        broker.publish('ws.order.12', 'garbage');
        broker.publish('ws.order.12', '{"t":"Bad Type","d":1}');
        expect(client.peer.frames).toHaveLength(before);
    });

    it("tells which channel or request was throttled, so the client can ask again", () => {
        const flood: Client = connect(1);
        for (let i = 0; i < 40; i++) {
            flood.hub.receive('{"op":"ping"}');
        }
        flood.hub.receive('{"op":"sub","ch":"order:12"}');
        expect(flood.peer.last()).toEqual({op: 'error', code: 'rate_limited', ch: 'order:12'});
        flood.hub.receive('{"op":"send","ch":"order:12","t":"notes.message","d":null,"id":"9"}');
        expect(flood.peer.last()).toEqual({op: 'error', code: 'rate_limited', ch: 'order:12', id: '9'});
    });

    it("closes the members of a channel whose broker subscription failed, so they subscribe afresh", async () => {
        const a: Client = connect(1);
        const b: Client = connect(2);
        a.hub.receive('{"op":"sub","ch":"order:12"}');
        b.hub.receive('{"op":"sub","ch":"order:14"}');
        await flush();

        broker.fail('ws.order.12');

        expect(a.peer.closedWith).toEqual({code: 1012, reason: 'Resubscribe'});
        expect(b.peer.closedWith).toBeNull();
        expect(hub.stats()).toEqual({connections: 1, channels: 1});
    });

    it("refuses a second controller for one channel type and names it cannot carry", () => {
        expect(() => hub.register('order', orders)).toThrow(/already registered/);
        expect(() => hub.register('user', orders)).toThrow(/Invalid/);
        expect(() => hub.register('Order', orders)).toThrow(/Invalid/);
    });

    function registerRoom(presence: boolean, join: () => boolean | Promise<boolean>): void {
        hub.register('room', {
            lossy: false,
            presence,
            join,
            leave: (): void => undefined,
            messages: new Map<string, SocketMessageHandler>(),
        });
    }

    it("enters and exits presence channels for accounts", async () => {
        registerRoom(true, (): boolean => true);
        const client: Client = connect(7);
        client.hub.receive('{"op":"sub","ch":"room:1"}');
        client.hub.receive('{"op":"sub","ch":"room:2"}');
        await flush();
        expect(presenceCalls).toEqual(['enter room:1 7', 'enter room:2 7']);

        client.hub.receive('{"op":"unsub","ch":"room:1"}');
        await flush();
        expect(presenceCalls).toEqual(['enter room:1 7', 'enter room:2 7', 'exit room:1 7']);

        client.hub.closed();
        await flush();
        expect(presenceCalls).toEqual(['enter room:1 7', 'enter room:2 7', 'exit room:1 7', 'exit room:2 7']);
    });

    it("never tracks guests, refused joins or channels without presence", async () => {
        registerRoom(true, (): boolean => true);
        hub.register('lobby', {
            lossy: false,
            presence: true,
            join: (): boolean => false,
            leave: (): void => undefined,
            messages: new Map<string, SocketMessageHandler>(),
        });
        hub.register('plain', {
            lossy: false,
            presence: false,
            join: (): boolean => true,
            leave: (): void => undefined,
            messages: new Map<string, SocketMessageHandler>(),
        });
        const guest: Client = connect(null);
        guest.hub.receive('{"op":"sub","ch":"room:1"}');
        const account: Client = connect(7);
        account.hub.receive('{"op":"sub","ch":"lobby:1"}');
        account.hub.receive('{"op":"sub","ch":"plain:1"}');
        account.hub.receive('{"op":"sub","ch":"user"}');
        await flush();
        guest.hub.closed();
        account.hub.closed();
        await flush();

        expect(presenceCalls).toEqual([]);
    });

    it("never tracks an account id that is not a positive safe integer", async () => {
        registerRoom(true, (): boolean => true);
        const userIds: number[] = [0, -3, 1.5, 2 ** 53];
        for (const userId of userIds) {
            const client: Client = connect(userId);
            client.hub.receive('{"op":"sub","ch":"room:1"}');
            await flush();
            expect(client.peer.last()).toEqual({op: 'subscribed', ch: 'room:1'});
            expect(() => client.hub.receive('{"op":"unsub","ch":"room:1"}')).not.toThrow();
            await flush();
            expect(() => client.hub.closed()).not.toThrow();
            await flush();
        }

        expect(presenceCalls).toEqual([]);
    });

    it("exits a subscription whose join finished after the disconnect", async () => {
        let release: (allowed: boolean) => void = (): void => undefined;
        registerRoom(true, (): Promise<boolean> => new Promise<boolean>((resolve: (allowed: boolean) => void): void => {
            release = resolve;
        }));
        const client: Client = connect(7);
        client.hub.receive('{"op":"sub","ch":"room:1"}');
        await flush();
        client.hub.closed();
        release(true);
        await flush();

        expect(presenceCalls).toEqual([]);
    });

    it("answers failed and calls leave when the broker refuses the subscription", async () => {
        const client: Client = connect(1);
        const subscribe: jest.SpyInstance = jest.spyOn(broker, 'subscribe').mockImplementation((): never => {
            throw new Error('connection closed');
        });

        client.hub.receive('{"op":"sub","ch":"order:12"}');
        client.hub.receive('{"op":"sub","ch":"user"}');
        await flush();
        subscribe.mockRestore();

        expect(client.peer.frames.slice(1)).toEqual(expect.arrayContaining([
            {op: 'error', code: 'failed', ch: 'order:12'},
            {op: 'error', code: 'failed', ch: 'user'},
        ]));
        expect(events).toEqual(['join order:12 c1', 'leave order:12 c1']);
        expect(hub.stats()).toEqual({connections: 1, channels: 0});
    });

    it("calls disconnect only after the leave of a join that was still pending when the connection closed", async () => {
        let release: (allowed: boolean) => void = (): void => undefined;
        hub.register('room', {
            lossy: false,
            presence: false,
            join: (): Promise<boolean> => new Promise<boolean>((resolve: (allowed: boolean) => void): void => {
                release = resolve;
            }),
            leave: (context: SocketContext): void => {
                events.push(`leave ${context.channel}`);
            },
            messages: new Map<string, SocketMessageHandler>(),
        });
        const client: Client = connect(1);
        client.hub.receive('{"op":"sub","ch":"room:1"}');
        await flush();

        client.hub.closed();
        await flush();
        expect(disconnected).toEqual([]);

        release(true);
        await flush();
        expect(events).toEqual(['leave room:1', 'disconnect c1']);
    });

    it("answers not_subscribed to a queued message whose channel was left, and calls leave after the message in progress", async () => {
        let release: () => void = (): void => undefined;
        hub.register('room', {
            lossy: false,
            presence: false,
            join: (): boolean => true,
            leave: (context: SocketContext): void => {
                events.push(`leave ${context.channel}`);
            },
            messages: new Map<string, SocketMessageHandler>([
                ['slow', message(async (): Promise<string> => {
                    events.push('slow start');
                    await new Promise<void>((resolve: () => void): void => {
                        release = resolve;
                    });
                    events.push('slow end');
                    return 'done';
                })],
                ['next', message((): void => {
                    events.push('next');
                })],
            ]),
        });
        const client: Client = connect(1);
        client.hub.receive('{"op":"sub","ch":"room:1"}');
        await flush();

        client.hub.receive('{"op":"send","ch":"room:1","t":"slow","d":null,"id":"1"}');
        client.hub.receive('{"op":"send","ch":"room:1","t":"next","d":null,"id":"2"}');
        await flush();
        client.hub.receive('{"op":"unsub","ch":"room:1"}');
        await flush();
        expect(events).toEqual(['slow start']);

        release();
        await flush();
        expect(events).toEqual(['slow start', 'slow end', 'leave room:1']);
        expect(client.peer.frames.slice(-2)).toEqual([
            {op: 'ack', id: '1', d: 'done'},
            {op: 'error', code: 'not_subscribed', ch: 'room:1', id: '2'},
        ]);
    });

    it("subscribes a channel asked for again while its join was cancelled, and joins nothing after stop", async () => {
        const client: Client = connect(1);
        client.hub.receive('{"op":"sub","ch":"order:12"}');
        client.hub.receive('{"op":"unsub","ch":"order:12"}');
        client.hub.receive('{"op":"sub","ch":"order:12"}');
        await flush();
        expect(client.peer.last()).toEqual({op: 'subscribed', ch: 'order:12'});
        expect(broker.subjects()).toEqual(['ws.order.12']);

        hub.stop();
        const late: Client = connect(2);
        late.hub.receive('{"op":"sub","ch":"order:14"}');
        await flush();
        expect(broker.subjects()).toEqual([]);
        expect(late.peer.frames).toEqual([{op: 'hello', v: 1, user: 2}]);
    });

    it("leaves every broker subject on stop", async () => {
        connect(1).hub.receive('{"op":"sub","ch":"order:12"}');
        await flush();
        hub.stop();

        expect(broker.subjects()).toEqual([]);
    });
});
