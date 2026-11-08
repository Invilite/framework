/* eslint-disable @typescript-eslint/no-require-imports */
type Handler = ((event: {data?: string; code?: number}) => void) | null;

class FakeWebSocket {
    public static instances: FakeWebSocket[] = [];
    public readonly sent: Record<string, unknown>[] = [];
    public onmessage: Handler = null;
    public onclose: Handler = null;
    public closed: boolean = false;

    public constructor(public readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    public static last(): FakeWebSocket {
        return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    }

    public send(frame: string): void {
        this.sent.push(JSON.parse(frame) as Record<string, unknown>);
    }

    public close(): void {
        this.closed = true;
    }

    public server(frame: Record<string, unknown>): void {
        this.onmessage?.({data: JSON.stringify(frame)});
    }

    public drop(code: number = 1006): void {
        this.onclose?.({code});
    }
}

interface Connection {
    subscribe(name: string): void;
    unsubscribe(name: string): void;
    send(name: string, type: string, data: unknown): Promise<unknown>;
    expectUser(id: number | null): void;
    check(): void;
    state(): string;
    close(): void;
}

const {createConnection} = require('../../src/client/socket/websocket-events-connection.js') as {
    createConnection(options: Record<string, unknown>): Connection;
};

describe("socket client connection script", () => {
    let events: unknown[];
    let session: jest.Mock;

    function open(): Connection {
        return createConnection({
            url: 'ws://site/socket',
            sessionUrl: '/socket/session',
            WebSocket: FakeWebSocket,
            fetch: session,
            random: (): number => 1,
            timers: {setTimeout, clearTimeout},
            on: {
                status: (state: string, user: number | null): number => events.push(['status', state, user]),
                identity: (user: number | null): number => events.push(['identity', user]),
                subscription: (ch: string, ok: boolean, code: string | null): number => events.push(['subscription', ch, ok, code]),
                event: (ch: string, type: string, data: unknown): number => events.push(['event', ch, type, data]),
            },
        });
    }

    beforeEach(() => {
        jest.useFakeTimers();
        FakeWebSocket.instances = [];
        events = [];
        session = jest.fn();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("connects only when something is subscribed and subscribes after hello", () => {
        const connection: Connection = open();
        connection.expectUser(null);
        expect(FakeWebSocket.instances).toHaveLength(0);

        connection.subscribe('order:12');
        const socket: FakeWebSocket = FakeWebSocket.last();
        expect(socket.url).toEqual('ws://site/socket');
        expect(socket.sent).toEqual([]);

        socket.server({op: 'hello', v: 1, user: null});
        socket.server({op: 'subscribed', ch: 'order:12'});
        socket.server({op: 'event', ch: 'order:12', t: 'watchers', d: {count: 3}});

        expect(socket.sent).toEqual([{op: 'sub', ch: 'order:12'}]);
        expect(connection.state()).toEqual('open');
        expect(events).toContainEqual(['subscription', 'order:12', true, null]);
        expect(events).toContainEqual(['event', 'order:12', 'watchers', {count: 3}]);
    });

    it("reconnects after a drop with growing delays and subscribes again", () => {
        const connection: Connection = open();
        connection.expectUser(null);
        connection.subscribe('order:12');
        FakeWebSocket.last().server({op: 'hello', v: 1, user: null});

        FakeWebSocket.last().drop();
        expect(connection.state()).toEqual('offline');
        jest.advanceTimersByTime(999);
        expect(FakeWebSocket.instances).toHaveLength(1);
        jest.advanceTimersByTime(1);
        expect(FakeWebSocket.instances).toHaveLength(2);

        FakeWebSocket.last().drop();
        jest.advanceTimersByTime(1999);
        expect(FakeWebSocket.instances).toHaveLength(2);
        jest.advanceTimersByTime(1);
        expect(FakeWebSocket.instances).toHaveLength(3);

        FakeWebSocket.last().server({op: 'hello', v: 1, user: null});
        expect(FakeWebSocket.last().sent).toEqual([{op: 'sub', ch: 'order:12'}]);

        // A successful hello resets the backoff.
        FakeWebSocket.last().drop();
        jest.advanceTimersByTime(1000);
        expect(FakeWebSocket.instances).toHaveLength(4);
    });

    it("drops a socket that stops answering pings and reconnects", () => {
        const connection: Connection = open();
        connection.expectUser(null);
        connection.subscribe('order:12');
        const first: FakeWebSocket = FakeWebSocket.last();
        first.server({op: 'hello', v: 1, user: null});

        jest.advanceTimersByTime(25_000);
        expect(first.sent).toContainEqual({op: 'ping'});
        first.server({op: 'pong'});
        jest.advanceTimersByTime(25_000);
        jest.advanceTimersByTime(10_000);

        expect(first.closed).toBe(true);
        jest.advanceTimersByTime(1000);
        expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it("checks a socket at once after a network change", () => {
        const connection: Connection = open();
        connection.expectUser(null);
        connection.subscribe('order:12');
        const socket: FakeWebSocket = FakeWebSocket.last();
        socket.server({op: 'hello', v: 1, user: null});

        connection.check();
        expect(socket.sent).toContainEqual({op: 'ping'});
        jest.advanceTimersByTime(10_000);
        expect(socket.closed).toBe(true);
    });

    it("refreshes the session when the socket connects as someone else than the page expects", async () => {
        session.mockResolvedValue({user: 42});
        const connection: Connection = open();
        connection.expectUser(42);
        connection.subscribe('user');
        const guest: FakeWebSocket = FakeWebSocket.last();
        guest.server({op: 'hello', v: 1, user: null});

        expect(guest.closed).toBe(true);
        expect(guest.sent).toEqual([]);
        expect(session).toHaveBeenCalledWith('/socket/session');
        await Promise.resolve();
        await Promise.resolve();

        const account: FakeWebSocket = FakeWebSocket.last();
        expect(account).not.toBe(guest);
        account.server({op: 'hello', v: 1, user: 42});
        expect(account.sent).toEqual([{op: 'sub', ch: 'user'}]);
        expect(events).toContainEqual(['identity', 42]);
    });

    it("accepts the server's answer when the session check confirms a logout", async () => {
        session.mockResolvedValue({user: null});
        const connection: Connection = open();
        connection.expectUser(42);
        connection.subscribe('order:12');
        FakeWebSocket.last().server({op: 'hello', v: 1, user: null});
        await Promise.resolve();
        await Promise.resolve();

        FakeWebSocket.last().server({op: 'hello', v: 1, user: null});
        expect(connection.state()).toEqual('open');
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(session).toHaveBeenCalledTimes(1);
    });

    it("forgets a refused channel instead of asking again after a reconnect", () => {
        const connection: Connection = open();
        connection.expectUser(null);
        connection.subscribe('order:12');
        connection.subscribe('user');
        FakeWebSocket.last().server({op: 'hello', v: 1, user: null});
        FakeWebSocket.last().server({op: 'error', code: 'forbidden', ch: 'user'});
        expect(events).toContainEqual(['subscription', 'user', false, 'forbidden']);

        FakeWebSocket.last().drop();
        jest.advanceTimersByTime(1000);
        FakeWebSocket.last().server({op: 'hello', v: 1, user: null});
        expect(FakeWebSocket.last().sent).toEqual([{op: 'sub', ch: 'order:12'}]);
    });

    it("answers a send with the server's ack or error and rejects it while offline", async () => {
        const connection: Connection = open();
        connection.expectUser(1);
        await expect(connection.send('order:12', 'notes.message', {})).rejects.toThrow('offline');

        connection.subscribe('order:12');
        const socket: FakeWebSocket = FakeWebSocket.last();
        socket.server({op: 'hello', v: 1, user: 1});
        const accepted: Promise<unknown> = connection.send('order:12', 'notes.message', {text: 'a'});
        const refused: Promise<unknown> = connection.send('order:12', 'notes.message', {text: 'b'});
        socket.server({op: 'ack', id: '1'});
        socket.server({op: 'error', code: 'paused', ch: 'order:12', id: '2'});

        await expect(accepted).resolves.toBeUndefined();
        await expect(refused).rejects.toThrow('paused');
    });

    it("resolves a send with the data the server put in its ack", async () => {
        const connection: Connection = open();
        connection.expectUser(1);
        connection.subscribe('order:12');
        const socket: FakeWebSocket = FakeWebSocket.last();
        socket.server({op: 'hello', v: 1, user: 1});

        const history: Promise<unknown> = connection.send('order:12', 'notes.history', {});
        socket.server({op: 'ack', id: '1', d: {messages: [1, 2]}});

        await expect(history).resolves.toEqual({messages: [1, 2]});
    });

    it("closes the socket a while after the last channel is gone, and keeps it for a quick resubscribe", () => {
        const connection: Connection = open();
        connection.expectUser(null);
        connection.subscribe('order:12');
        const socket: FakeWebSocket = FakeWebSocket.last();
        socket.server({op: 'hello', v: 1, user: null});

        connection.unsubscribe('order:12');
        jest.advanceTimersByTime(5000);
        connection.subscribe('order:14');
        jest.advanceTimersByTime(10_000);
        expect(socket.closed).toBe(false);
        expect(socket.sent).toEqual([{op: 'sub', ch: 'order:12'}, {op: 'unsub', ch: 'order:12'}, {op: 'sub', ch: 'order:14'}]);

        connection.unsubscribe('order:14');
        jest.advanceTimersByTime(10_000);
        expect(socket.closed).toBe(true);
        expect(connection.state()).toEqual('idle');
    });

    it("asks again for a channel the server throttled", () => {
        const connection: Connection = open();
        connection.expectUser(null);
        connection.subscribe('order:12');
        const socket: FakeWebSocket = FakeWebSocket.last();
        socket.server({op: 'hello', v: 1, user: null});
        socket.server({op: 'error', code: 'rate_limited', ch: 'order:12'});

        expect(events).not.toContainEqual(['subscription', 'order:12', false, 'rate_limited']);
        jest.advanceTimersByTime(2000);
        expect(socket.sent).toEqual([{op: 'sub', ch: 'order:12'}, {op: 'sub', ch: 'order:12'}]);
    });

    it("checks the session again when the previous check could not reach the server", async () => {
        session.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce({user: 42});
        const connection: Connection = open();
        connection.expectUser(42);
        connection.subscribe('user');
        FakeWebSocket.last().server({op: 'hello', v: 1, user: null});
        await Promise.resolve();
        await Promise.resolve();

        jest.advanceTimersByTime(1000);
        FakeWebSocket.last().server({op: 'hello', v: 1, user: null});
        expect(session).toHaveBeenCalledTimes(2);
        expect(connection.state()).not.toEqual('open');
    });

    it("reconnects as the account a new page expects when the open socket belongs to someone else", () => {
        const connection: Connection = open();
        connection.expectUser(7);
        connection.subscribe('user');
        const old: FakeWebSocket = FakeWebSocket.last();
        old.server({op: 'hello', v: 1, user: 7});

        connection.expectUser(null);
        expect(old.closed).toBe(true);
        jest.advanceTimersByTime(1000);
        FakeWebSocket.last().server({op: 'hello', v: 1, user: null});
        expect(connection.state()).toEqual('open');
        expect(events).toContainEqual(['identity', null]);
    });

    it("reconnects when the server closes for a restart", () => {
        const connection: Connection = open();
        connection.expectUser(null);
        connection.subscribe('order:12');
        FakeWebSocket.last().server({op: 'hello', v: 1, user: null});

        FakeWebSocket.last().drop(1000);
        jest.advanceTimersByTime(1000);
        expect(FakeWebSocket.instances).toHaveLength(2);
    });
});
