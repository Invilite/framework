import {KV, KvEntry, Msg, NatsConnection} from "nats";
import {NatsError} from "nats/lib/nats-base-client/core";
import HeartbeatTracker, {HEARTBEAT_TTL_MS} from "../../src/services/HeartbeatTracker";

interface StoredEntry {
    payload: unknown;
    created: Date;
    operation: "PUT" | "DEL" | "PURGE";
}

const asyncIterable = <T>(items: T[]): AsyncIterable<T> => ({
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<T> {
        for (const item of items) {
            yield item;
        }
    },
});

class FakeKv {
    public readonly entries: Map<string, StoredEntry> = new Map<string, StoredEntry>();
    public readonly listedKeys: string[] = [];
    public readonly keys = jest.fn(async (): Promise<AsyncIterable<string>> => asyncIterable(this.listedKeys));

    public readonly get = jest.fn(async (key: string): Promise<KvEntry | null> => {
        const stored: StoredEntry | undefined = this.entries.get(key);
        if (stored === undefined) {
            return null;
        }
        return {
            bucket: 'heartbeat',
            key,
            value: new Uint8Array(),
            created: stored.created,
            revision: 1,
            operation: stored.operation,
            length: 0,
            json: (): unknown => stored.payload,
            string: (): string => JSON.stringify(stored.payload),
        } as KvEntry;
    });

    public seed(key: string, payload: unknown, created: Date = new Date(), operation: "PUT" | "DEL" | "PURGE" = 'PUT'): void {
        this.entries.set(key, {payload, created, operation});
    }
}

interface Subscription {
    unsubscribe: jest.Mock;
}

interface Handler {
    subject: string;
    callback: (error: NatsError | null, message: Msg) => void;
    subscription: Subscription;
}

class FakeNats {
    public readonly handlers: Handler[] = [];

    public subscribe(subject: string, options: {callback: (error: NatsError | null, message: Msg) => void}): Subscription {
        const subscription: Subscription = {unsubscribe: jest.fn()};
        this.handlers.push({subject, callback: options.callback, subscription});
        return subscription;
    }

    public message(subject: string, payload: unknown): void {
        const handler: Handler = this.handlers[this.handlers.length - 1];
        handler.callback(null, {subject, string: (): string => JSON.stringify(payload)} as Msg);
    }
}

describe("HeartbeatTracker", () => {
    let nats: FakeNats;
    let kv: FakeKv;
    let tracker: HeartbeatTracker;

    const create = (): HeartbeatTracker => new HeartbeatTracker(
        nats as unknown as NatsConnection,
        kv as unknown as KV,
        'presence',
    );

    beforeEach((): void => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-10-23T10:00:00.000Z'));
        nats = new FakeNats();
        kv = new FakeKv();
    });

    afterEach((): void => {
        tracker?.stop();
        jest.useRealTimers();
    });

    it("snapshot: tylko wpisy alive=true, subskrypcja przed odczytem KV", async (): Promise<void> => {
        kv.seed('presence.1', {alive: true}, new Date(Date.now() - 1_000));
        kv.seed('presence.2', {alive: false}, new Date(Date.now() - 1_000));
        kv.seed('presence.3', {alive: true}, new Date(Date.now() - 1_000), 'DEL');
        kv.listedKeys.push('presence.1', 'presence.2', 'presence.3');
        tracker = create();

        await tracker.start();

        expect(nats.handlers).toHaveLength(1);
        expect(nats.handlers[0].subject).toBe('heartbeat.presence.>');
        expect(kv.keys).toHaveBeenCalledWith('presence.>');
        expect(tracker.isAlive('1')).toBe(true);
        expect(tracker.isAlive('2')).toBe(false);
        expect(tracker.isAlive('3')).toBe(false);
    });

    it("beat z subskrypcji ustawia żywotność, alive=false usuwa klucz", async (): Promise<void> => {
        tracker = create();
        await tracker.start();

        nats.message('heartbeat.presence.7', {alive: true});
        expect(tracker.isAlive('7')).toBe(true);

        nats.message('heartbeat.presence.7', {alive: false});
        expect(tracker.isAlive('7')).toBe(false);
    });

    it("wpis wygasa po 60 s od ostatniego beatu", async (): Promise<void> => {
        tracker = create();
        await tracker.start();

        nats.message('heartbeat.presence.1', {alive: true});
        jest.advanceTimersByTime(HEARTBEAT_TTL_MS - 1);
        expect(tracker.isAlive('1')).toBe(true);
        jest.advanceTimersByTime(1);
        expect(tracker.isAlive('1')).toBe(false);
    });

    it("stop odpina subskrypcję i czyści stan", async (): Promise<void> => {
        kv.seed('presence.1', {alive: true});
        kv.listedKeys.push('presence.1');
        tracker = create();
        await tracker.start();

        tracker.stop();

        expect(nats.handlers[0].subscription.unsubscribe).toHaveBeenCalledTimes(1);
        expect(tracker.isAlive('1')).toBe(false);
    });

    it("wyścig: świeży beat z subskrypcji nie jest nadpisany starszym wpisem snapshotu", async (): Promise<void> => {
        kv.listedKeys.push('presence.1');
        let resolveSnapshot: (entry: KvEntry | null) => void = (): void => {};
        const snapshot: Promise<KvEntry | null> = new Promise<KvEntry | null>((resolve) => {
            resolveSnapshot = resolve;
        });
        kv.get.mockImplementationOnce((): Promise<KvEntry | null> => snapshot);
        tracker = create();

        const started: Promise<void> = tracker.start();
        while (kv.get.mock.calls.length === 0) {
            await Promise.resolve();
        }

        nats.message('heartbeat.presence.1', {alive: true});
        resolveSnapshot({
            bucket: 'heartbeat',
            key: 'presence.1',
            value: new Uint8Array(),
            created: new Date(Date.now() - HEARTBEAT_TTL_MS + 10_000),
            revision: 1,
            operation: 'PUT',
            length: 0,
            json: (): unknown => ({alive: true}),
            string: (): string => JSON.stringify({alive: true}),
        } as KvEntry);
        await started;

        jest.advanceTimersByTime(20_000);
        expect(tracker.isAlive('1')).toBe(true);
    });

    it("wygasłe wpisy są usuwane przy kolejnym beacie (bez timerów)", async (): Promise<void> => {
        tracker = create();
        await tracker.start();

        const lastBeatAt: Map<string, number> = (tracker as unknown as {lastBeatAt: Map<string, number>}).lastBeatAt;

        nats.message('heartbeat.presence.1', {alive: true});
        expect(lastBeatAt.size).toBe(1);

        jest.advanceTimersByTime(HEARTBEAT_TTL_MS + 1);
        nats.message('heartbeat.presence.2', {alive: true});

        expect(lastBeatAt.has('presence.1')).toBe(false);
        expect(lastBeatAt.has('presence.2')).toBe(true);
    });
});
