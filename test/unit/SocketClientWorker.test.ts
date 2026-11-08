/* eslint-disable @typescript-eslint/no-require-imports */
interface Router {
    connect(port: FakePort): void;
    handle(port: FakePort, message: Record<string, unknown>): void;
    sweep(): void;
    portCount(): number;
}

type On = {
    status(state: string, user: number | null): void;
    subscription(ch: string, ok: boolean, code: string | null): void;
    event(ch: string, type: string, data: unknown): void;
};

class FakePort {
    public readonly received: Record<string, unknown>[] = [];
    public onmessage: ((message: {data: Record<string, unknown>}) => void) | null = null;
    public closed: boolean = false;

    public postMessage(message: Record<string, unknown>): void {
        this.received.push(message);
    }

    public start(): void {
    }

    public close(): void {
        this.closed = true;
    }

    public tab(message: Record<string, unknown>): void {
        this.onmessage?.({data: message});
    }
}

const {createRouter} = require('../../src/client/socket/websocket-events-worker.js') as {
    createRouter(options: Record<string, unknown>): Router;
};

describe("socket client shared worker", () => {
    let calls: unknown[][];
    let on: On;
    let now: number;
    let router: Router;
    let sendResult: Promise<void>;

    beforeEach(() => {
        calls = [];
        now = 0;
        sendResult = Promise.resolve();
        router = createRouter({
            timers: {setInterval: (): void => undefined, now: (): number => now},
            createConnection: (callbacks: On) => {
                on = callbacks;
                return {
                    subscribe: (ch: string): number => calls.push(['subscribe', ch]),
                    unsubscribe: (ch: string): number => calls.push(['unsubscribe', ch]),
                    expectUser: (user: number | null): number => calls.push(['expectUser', user]),
                    check: (): number => calls.push(['check']),
                    send: (ch: string, type: string, data: unknown): Promise<void> => {
                        calls.push(['send', ch, type, data]);
                        return sendResult;
                    },
                };
            },
        });
    });

    function tab(): FakePort {
        const port: FakePort = new FakePort();
        router.connect(port);
        return port;
    }

    it("holds one subscription per channel for all tabs and routes events only to the tabs in it", () => {
        const a: FakePort = tab();
        const b: FakePort = tab();
        a.tab({type: 'hello', user: 7});
        a.tab({type: 'sub', ch: 'order:12'});
        b.tab({type: 'sub', ch: 'order:12'});
        b.tab({type: 'sub', ch: 'user'});

        expect(calls).toEqual([['expectUser', 7], ['subscribe', 'order:12'], ['subscribe', 'user']]);

        on.event('user', 'notification', {id: 1});
        on.event('order:12', 'watchers', {count: 2});
        expect(a.received.filter((m) => m.type === 'event')).toEqual([{type: 'event', ch: 'order:12', t: 'watchers', d: {count: 2}}]);
        expect(b.received.filter((m) => m.type === 'event')).toHaveLength(2);

        a.tab({type: 'unsub', ch: 'order:12'});
        expect(calls).toHaveLength(3);
        b.tab({type: 'detach'});
        expect(calls.slice(3)).toEqual([['unsubscribe', 'order:12'], ['unsubscribe', 'user']]);
        expect(b.closed).toBe(true);
        expect(router.portCount()).toEqual(1);
    });

    it("tells a late tab at once that a shared channel is already confirmed, and every tab the status", () => {
        const a: FakePort = tab();
        a.tab({type: 'sub', ch: 'order:12'});
        on.status('open', null);
        on.subscription('order:12', true, null);

        const b: FakePort = tab();
        expect(b.received[0]).toEqual({type: 'status', state: 'open', user: null});
        b.tab({type: 'sub', ch: 'order:12'});
        expect(b.received).toContainEqual({type: 'subscription', ch: 'order:12', ok: true, code: null});
    });

    it("does not report a channel as confirmed by an answer that came after its last tab left", () => {
        const a: FakePort = tab();
        a.tab({type: 'sub', ch: 'order:12'});
        a.tab({type: 'unsub', ch: 'order:12'});
        on.subscription('order:12', true, null);

        const b: FakePort = tab();
        const c: FakePort = tab();
        b.tab({type: 'sub', ch: 'order:12'});
        c.tab({type: 'sub', ch: 'order:12'});
        expect(c.received.filter((message: Record<string, unknown>): boolean => message.type === 'subscription')).toEqual([]);

        on.subscription('order:12', true, null);
        expect(c.received).toContainEqual({type: 'subscription', ch: 'order:12', ok: true, code: null});
    });

    it("passes a refusal to the tabs that asked and forgets the channel", () => {
        const a: FakePort = tab();
        a.tab({type: 'sub', ch: 'user'});
        on.subscription('user', false, 'forbidden');

        expect(a.received).toContainEqual({type: 'subscription', ch: 'user', ok: false, code: 'forbidden'});
        a.tab({type: 'sub', ch: 'user'});
        expect(calls).toEqual([['subscribe', 'user'], ['subscribe', 'user']]);
    });

    it("answers a send to the tab that sent it", async () => {
        const a: FakePort = tab();
        const b: FakePort = tab();
        a.tab({type: 'send', id: '4', ch: 'order:12', t: 'notes.message', d: {text: 'hi'}});
        await sendResult;
        await Promise.resolve();

        expect(a.received).toContainEqual({type: 'reply', id: '4', ok: true, code: null});
        expect(b.received.filter((m) => m.type === 'reply')).toEqual([]);

        sendResult = Promise.reject(new Error('paused'));
        sendResult.catch(() => undefined);
        b.tab({type: 'send', id: '1', ch: 'order:12', t: 'notes.message', d: {}});
        await Promise.resolve();
        await Promise.resolve();
        expect(b.received).toContainEqual({type: 'reply', id: '1', ok: false, code: 'paused'});
    });

    it("passes the data of an ack to the tab that sent the message", async () => {
        const a: FakePort = tab();
        sendResult = Promise.resolve({messages: [1]}) as unknown as Promise<void>;
        a.tab({type: 'send', id: '5', ch: 'order:12', t: 'notes.history', d: {}});
        await sendResult;
        await Promise.resolve();

        expect(a.received).toContainEqual({type: 'reply', id: '5', ok: true, code: null, d: {messages: [1]}});
    });

    it("drops a silent tab and takes it back in full with its next heartbeat", () => {
        const sleeping: FakePort = tab();
        const awake: FakePort = tab();
        sleeping.tab({type: 'alive', channels: ['order:12', 'user']});
        awake.tab({type: 'alive', channels: []});

        now = 120_000;
        awake.tab({type: 'alive', channels: []});
        now = 200_000;
        router.sweep();
        expect(router.portCount()).toEqual(1);
        // Closing the port would cut the tab off for good: it must still be able to reach the worker.
        expect(sleeping.closed).toBe(false);
        expect(calls).toEqual([['subscribe', 'order:12'], ['subscribe', 'user'], ['unsubscribe', 'order:12'], ['unsubscribe', 'user']]);

        sleeping.tab({type: 'alive', channels: ['order:12']});
        expect(router.portCount()).toEqual(2);
        expect(calls.slice(4)).toEqual([['subscribe', 'order:12']]);

        sleeping.tab({type: 'alive', channels: []});
        expect(calls.slice(5)).toEqual([['unsubscribe', 'order:12']]);
    });
});
