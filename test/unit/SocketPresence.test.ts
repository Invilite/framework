import {MemorySocketBroker} from "../../src/services/Socket/MemorySocketBroker";
import {SocketPublisher} from "../../src/services/Socket/SocketPublisher";
import {SocketPresence, SocketPresenceHandler} from "../../src/services/Socket/SocketPresence";
import {SocketBroker, SocketBrokerSubscription} from "../../src/types/interfaces/SocketBroker";
import {SocketPresenceChange} from "../../src/types/interfaces/SocketPresenceChange";
import {AbstractLogger} from "../../src/types/interfaces/AbstractLogger";

class FilteredBroker implements SocketBroker {
    public filter: (payload: string) => boolean = (): boolean => true;
    public receiving: boolean = true;
    public subscribeFailure: Error | null = null;
    public lastFailed: ((error: Error) => void) | null = null;

    public constructor(private readonly shared: MemorySocketBroker) {
    }

    public publish(subject: string, payload: string): void {
        if (this.filter(payload)) {
            this.shared.publish(subject, payload);
        }
    }

    public subscribe(subject: string, deliver: (payload: string) => void, failed: (error: Error) => void): SocketBrokerSubscription {
        if (this.subscribeFailure !== null) {
            throw this.subscribeFailure;
        }
        this.lastFailed = failed;

        return this.shared.subscribe(subject, (payload: string): void => {
            if (this.receiving) {
                deliver(payload);
            }
        }, failed);
    }

    public partition(cut: boolean): void {
        this.receiving = !cut;
        this.filter = (): boolean => !cut;
    }
}

interface PresenceCall {
    channel: string;
    change: SocketPresenceChange;
}

interface Instance {
    presence: SocketPresence;
    broker: FilteredBroker;
    calls: PresenceCall[];
    log: jest.Mocked<AbstractLogger>;
}

function logger(): jest.Mocked<AbstractLogger> {
    return {
        trace: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        notice: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        critical: jest.fn(),
        alert: jest.fn(),
        emergency: jest.fn(),
    };
}

describe("socket presence", () => {
    let shared: MemorySocketBroker;
    let instances: Instance[];

    function instance(instanceId: string, handler?: SocketPresenceHandler): Instance {
        const broker: FilteredBroker = new FilteredBroker(shared);
        const presence: SocketPresence = new SocketPresence(new SocketPublisher(broker), {instanceId});
        const calls: PresenceCall[] = [];
        const log: jest.Mocked<AbstractLogger> = logger();
        presence.register('room', handler ?? ((channel: string, change: SocketPresenceChange): void => {
            calls.push({channel, change});
        }));
        presence.start(log);
        const created: Instance = {presence, broker, calls, log};
        instances.push(created);

        return created;
    }

    function cluster(count: number): Instance[] {
        const created: Instance[] = ['a', 'b', 'c'].slice(0, count).map((instanceId: string): Instance => instance(instanceId));
        advance(SocketPresence.DEFAULTS.syncWaitMs);

        return created;
    }

    function advance(milliseconds: number): void {
        jest.advanceTimersByTime(milliseconds);
    }

    function forget(...cleared: Instance[]): void {
        for (const each of cleared) {
            each.calls.length = 0;
        }
    }

    function messageKind(payload: string): string {
        return (JSON.parse(payload) as {k: string}).k;
    }

    beforeEach(() => {
        jest.useFakeTimers();
        shared = new MemorySocketBroker();
        instances = [];
    });

    afterEach(() => {
        for (const each of instances) {
            each.presence.stop();
        }
        jest.useRealTimers();
    });

    it("calls joined once in the cluster for the first subscription", () => {
        const [a, b, c]: Instance[] = cluster(3);

        a.presence.enter('room:1', 7);

        expect(a.calls).toEqual([{channel: 'room:1', change: {joined: [7], left: []}}]);
        expect(b.calls).toEqual([]);
        expect(c.calls).toEqual([]);
    });

    it("ignores a second tab and a second instance", () => {
        const [a, b, c]: Instance[] = cluster(3);

        a.presence.enter('room:1', 7);
        a.presence.enter('room:1', 7);
        b.presence.enter('room:1', 7);

        expect([...a.calls, ...b.calls, ...c.calls]).toEqual([{channel: 'room:1', change: {joined: [7], left: []}}]);
    });

    it("does not blink on a reload within the grace", () => {
        const [a, b, c]: Instance[] = cluster(3);
        a.presence.enter('room:1', 7);
        forget(a);

        a.presence.exit('room:1', 7);
        advance(4000);
        a.presence.enter('room:1', 7);
        advance(6000);

        expect([...a.calls, ...b.calls, ...c.calls]).toEqual([]);
    });

    it("keeps an account while another tab of it stays", () => {
        const [a, b, c]: Instance[] = cluster(3);
        a.presence.enter('room:1', 7);
        a.presence.enter('room:1', 7);
        forget(a);

        a.presence.exit('room:1', 7);
        advance(6000);

        expect([...a.calls, ...b.calls, ...c.calls]).toEqual([]);
    });

    it("does not blink when the account moves to another instance within the grace", () => {
        const [a, b, c]: Instance[] = cluster(3);
        a.presence.enter('room:1', 7);
        forget(a);

        a.presence.exit('room:1', 7);
        advance(2000);
        b.presence.enter('room:1', 7);
        advance(6000);

        expect([...a.calls, ...b.calls, ...c.calls]).toEqual([]);
    });

    it("reports left after the grace on the last instance", () => {
        const [a, b, c]: Instance[] = cluster(3);
        a.presence.enter('room:1', 7);
        forget(a);

        a.presence.exit('room:1', 7);
        advance(4999);
        expect(a.calls).toEqual([]);
        advance(2);

        expect(a.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [7]}}]);
        expect([...b.calls, ...c.calls]).toEqual([]);
    });

    it("hands left of a stopped instance to the lowest live instance", () => {
        const [a, b, c]: Instance[] = cluster(3);
        c.presence.enter('room:1', 7);
        c.presence.enter('room:2', 7);
        b.presence.enter('room:2', 7);
        forget(a, b, c);

        c.presence.stop();
        advance(4999);
        expect([...a.calls, ...b.calls, ...c.calls]).toEqual([]);
        advance(2);

        expect(a.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [7]}}]);
        expect(b.calls).toEqual([]);
        expect(c.calls).toEqual([]);
    });

    it("keeps the left of a stopped instance with the survivors when a lower id starts during the hold", async () => {
        const b: Instance = instance('b');
        const c: Instance = instance('c');
        advance(SocketPresence.DEFAULTS.syncWaitMs);
        c.presence.enter('room:1', 7);
        forget(b, c);

        c.presence.stop();
        advance(1500);
        const a: Instance = instance('a');
        advance(10000);

        expect(b.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [7]}}]);
        expect([...a.calls, ...c.calls]).toEqual([]);
        expect(await a.presence.members('room:1')).toEqual([]);
        expect(await b.presence.members('room:1')).toEqual([]);
    });

    it("keeps the left of a silent instance with the survivors when a lower id starts before the expiry", async () => {
        const b: Instance = instance('b');
        const c: Instance = instance('c');
        advance(SocketPresence.DEFAULTS.syncWaitMs);
        c.presence.enter('room:1', 7);
        forget(b, c);

        c.broker.partition(true);
        advance(3000);
        const a: Instance = instance('a');
        advance(40000);

        expect(b.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [7]}}]);
        expect(a.calls).toEqual([]);
        expect(await a.presence.members('room:1')).toEqual([]);
        expect(await b.presence.members('room:1')).toEqual([]);
    });

    it("hands the left of a stopped instance to a lower id that started before the bye", () => {
        const b: Instance = instance('b');
        const c: Instance = instance('c');
        advance(SocketPresence.DEFAULTS.syncWaitMs);
        c.presence.enter('room:1', 7);
        const a: Instance = instance('a');
        advance(SocketPresence.DEFAULTS.syncWaitMs);
        forget(a, b, c);

        c.presence.stop();
        advance(SocketPresence.DEFAULTS.graceMs + 1);

        expect(a.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [7]}}]);
        expect([...b.calls, ...c.calls]).toEqual([]);
    });

    it("keeps the left of a stopped instance with the survivors when a higher id starts during the hold", () => {
        const b: Instance = instance('b');
        const c: Instance = instance('c');
        advance(SocketPresence.DEFAULTS.syncWaitMs);
        c.presence.enter('room:1', 7);
        forget(b, c);

        c.presence.stop();
        advance(1500);
        const d: Instance = instance('d');
        advance(10000);

        expect(b.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [7]}}]);
        expect([...c.calls, ...d.calls]).toEqual([]);
    });

    it("does not blink on a rolling restart when clients reconnect within the grace", async () => {
        const [a, b, c]: Instance[] = cluster(3);
        c.presence.enter('room:1', 7);
        c.presence.enter('room:1', 3);
        forget(a, b, c);

        c.presence.stop();
        advance(2000);
        b.presence.enter('room:1', 7);
        a.presence.enter('room:1', 3);
        expect(await a.presence.members('room:1')).toEqual([3, 7]);
        advance(6000);

        expect([...a.calls, ...b.calls, ...c.calls]).toEqual([]);
        expect(await a.presence.members('room:1')).toEqual([3, 7]);
        expect(await b.presence.members('room:1')).toEqual([3, 7]);
    });

    it("leaves the left of a held account to the hold, not to a local grace ending during it", async () => {
        const [a, b, c]: Instance[] = cluster(3);
        a.presence.enter('room:1', 7);
        c.presence.enter('room:1', 7);
        a.presence.enter('room:2', 5);
        c.presence.enter('room:2', 5);
        forget(a, b, c);

        a.presence.exit('room:1', 7);
        a.presence.exit('room:2', 5);
        advance(1000);
        c.presence.stop();
        advance(4500);
        b.presence.enter('room:1', 7);
        advance(6000);

        expect(a.calls).toEqual([{channel: 'room:2', change: {joined: [], left: [5]}}]);
        expect([...b.calls, ...c.calls]).toEqual([]);
        expect(await a.presence.members('room:1')).toEqual([7]);
        forget(a);

        b.presence.exit('room:1', 7);
        advance(SocketPresence.DEFAULTS.graceMs);
        expect(b.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [7]}}]);
        expect(a.calls).toEqual([]);
    });

    it("treats a silent instance as gone after expireMs", () => {
        const [a, b, c]: Instance[] = cluster(3);
        c.presence.enter('room:1', 3);
        c.presence.enter('room:1', 7);
        forget(c);

        c.broker.filter = (): boolean => false;
        advance(29999);
        expect([...a.calls, ...b.calls, ...c.calls]).toEqual([]);
        advance(2);

        expect(a.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [3, 7]}}]);
        expect(b.calls).toEqual([]);
        expect(c.calls).toEqual([]);
    });

    it("reports joined again on both sides when a partition longer than expireMs heals", async () => {
        const [a, b]: Instance[] = cluster(2);
        a.presence.enter('room:1', 3);
        b.presence.enter('room:1', 7);
        forget(a, b);

        a.broker.partition(true);
        advance(31000);
        expect(a.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [7]}}]);
        expect(b.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [3]}}]);
        forget(a, b);

        a.broker.partition(false);
        advance(25000);

        expect(a.calls).toEqual([{channel: 'room:1', change: {joined: [7], left: []}}]);
        expect(b.calls).toEqual([{channel: 'room:1', change: {joined: [3], left: []}}]);
        expect(await a.presence.members('room:1')).toEqual([3, 7]);
        expect(await b.presence.members('room:1')).toEqual([3, 7]);
    });

    it("reports joined after a heal only for accounts absent from the rest of the view", () => {
        const [a, b, c]: Instance[] = cluster(3);
        a.presence.enter('room:1', 3);
        a.presence.enter('room:1', 5);
        b.presence.enter('room:1', 5);
        forget(a, b, c);

        a.broker.partition(true);
        advance(31000);
        expect(b.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [3]}}]);
        expect(c.calls).toEqual([]);
        forget(a, b, c);

        a.broker.partition(false);
        advance(25000);

        expect(b.calls).toEqual([{channel: 'room:1', change: {joined: [3], left: []}}]);
        expect(c.calls).toEqual([{channel: 'room:1', change: {joined: [3], left: []}}]);
        expect(a.calls).toEqual([]);
        forget(a, b, c);
        a.presence.enter('room:1', 9);
        advance(25000);

        expect(a.calls).toEqual([{channel: 'room:1', change: {joined: [9], left: []}}]);
        expect([...b.calls, ...c.calls]).toEqual([]);
    });

    it("hands off every channel of a silent instance whose last message touched only one of them", () => {
        const [a, b, c]: Instance[] = cluster(3);
        c.presence.enter('room:1', 7);
        c.presence.enter('room:2', 5);
        advance(SocketPresence.DEFAULTS.heartbeatMs);
        advance(3000);
        c.presence.enter('room:2', 9);
        forget(c);

        c.broker.filter = (): boolean => false;
        advance(30001);

        expect(a.calls).toEqual([
            {channel: 'room:1', change: {joined: [], left: [7]}},
            {channel: 'room:2', change: {joined: [], left: [5, 9]}},
        ]);
        expect([...b.calls, ...c.calls]).toEqual([]);
    });

    it("drops a stale entry of a live instance without a call", async () => {
        const [a, b, c]: Instance[] = cluster(3);
        b.presence.enter('room:1', 7);
        forget(b);
        b.broker.filter = (payload: string): boolean => messageKind(payload) !== 'left';

        b.presence.exit('room:1', 7);
        advance(SocketPresence.DEFAULTS.graceMs);
        expect(b.calls).toEqual([{channel: 'room:1', change: {joined: [], left: [7]}}]);
        expect(await a.presence.members('room:1')).toEqual([7]);
        advance(30001);

        expect(await a.presence.members('room:1')).toEqual([]);
        expect(await c.presence.members('room:1')).toEqual([]);
        expect([...a.calls, ...c.calls]).toEqual([]);
        expect(b.calls).toHaveLength(1);
    });

    it("lists members across instances, during grace too", async () => {
        const [a, b, c]: Instance[] = cluster(3);
        b.presence.enter('room:1', 7);
        c.presence.enter('room:1', 3);
        a.presence.enter('room:1', 7);
        a.presence.enter('room:2', 12);
        b.presence.exit('room:1', 7);
        a.presence.exit('room:1', 7);

        expect(await a.presence.members('room:1')).toEqual([3, 7]);
        expect(await b.presence.members('room:1')).toEqual([3, 7]);
        expect(await c.presence.members('room:2')).toEqual([12]);
        advance(SocketPresence.DEFAULTS.graceMs);
        expect(await c.presence.members('room:1')).toEqual([3]);
    });

    it("waits for the sync window before deciding a join", async () => {
        const [a]: Instance[] = cluster(1);
        a.presence.enter('room:1', 7);
        forget(a);

        const d: Instance = instance('d');
        d.presence.enter('room:1', 7);
        d.presence.enter('room:1', 3);
        const members: Promise<number[]> = d.presence.members('room:1');
        advance(SocketPresence.DEFAULTS.syncWaitMs - 1);
        expect(d.calls).toEqual([]);
        advance(1);

        expect(d.calls).toEqual([{channel: 'room:1', change: {joined: [3], left: []}}]);
        expect(a.calls).toEqual([]);
        expect(await members).toEqual([3, 7]);
        expect(await a.presence.members('room:1')).toEqual([3, 7]);
    });

    it("logs a failing handler and keeps working", async () => {
        const failure: Error = new Error('handler failed');
        const calls: PresenceCall[] = [];
        let failures: number = 0;
        const a: Instance = instance('a', (channel: string, change: SocketPresenceChange): void | Promise<void> => {
            failures++;
            if (failures === 1) {
                throw failure;
            }
            if (failures === 2) {
                return Promise.reject(failure);
            }
            calls.push({channel, change});
        });
        advance(SocketPresence.DEFAULTS.syncWaitMs);

        a.presence.enter('room:1', 3);
        a.presence.enter('room:1', 5);
        await Promise.resolve();
        a.presence.enter('room:1', 7);

        expect(calls).toEqual([{channel: 'room:1', change: {joined: [7], left: []}}]);
        expect(a.log.error).toHaveBeenCalledTimes(2);
        expect(a.log.error).toHaveBeenNthCalledWith(1, 'Presence change on "room:1" failed:', failure);
        expect(a.log.error).toHaveBeenNthCalledWith(2, 'Presence change on "room:1" failed:', failure);
    });

    it("refuses channels it cannot track", () => {
        const [a]: Instance[] = cluster(1);

        expect(() => a.presence.register('room', (): void => undefined)).toThrow();
        expect(() => a.presence.enter('order:1', 7)).toThrow();
        expect(() => a.presence.exit('room', 7)).toThrow();
        expect(() => a.presence.members('user')).toThrow();
    });

    it("ignores malformed and own messages", async () => {
        const [a]: Instance[] = cluster(1);
        const subject: string = 'ws.presence';

        shared.publish(subject, 'not json');
        shared.publish(subject, JSON.stringify({v: 2, i: 'x', k: 'joined', ch: 'room:1', u: [1]}));
        shared.publish(subject, JSON.stringify({v: 1, i: 'x', k: 'joined', ch: 'room:1', u: ['1']}));
        shared.publish(subject, JSON.stringify({v: 1, i: 'x', k: 'joined', ch: 'room', u: [1]}));
        shared.publish(subject, JSON.stringify({v: 1, i: 'x', k: 'unknown'}));
        shared.publish(subject, JSON.stringify({v: 1, i: 'a', k: 'joined', ch: 'room:1', u: [2]}));
        shared.publish(subject, JSON.stringify({v: 1, i: 'x', k: 'joined', ch: 'room:1', u: [9]}));

        expect(await a.presence.members('room:1')).toEqual([9]);
        expect(a.calls).toEqual([]);
    });

    it("keeps retrying on later heartbeats while the broker refuses to subscribe", async () => {
        const [a, b]: Instance[] = cluster(2);
        const closed: Error = new Error('connection closed');
        a.broker.subscribeFailure = closed;
        shared.fail('ws.presence');

        expect(() => advance(SocketPresence.DEFAULTS.heartbeatMs)).not.toThrow();
        expect(a.log.error).toHaveBeenCalledWith('Presence subscription failed:', closed);
        b.presence.enter('room:1', 3);
        a.broker.subscribeFailure = null;
        advance(SocketPresence.DEFAULTS.heartbeatMs);
        b.presence.enter('room:1', 7);

        expect(await a.presence.members('room:1')).toEqual([3, 7]);
    });

    it("subscribes again on the next heartbeat after the broker ends the subscription", async () => {
        const [a, b]: Instance[] = cluster(2);
        const failure: Error = new Error('slow consumer');

        shared.fail('ws.presence', failure);
        expect(a.log.error).toHaveBeenCalledWith('Presence subscription failed:', failure);
        expect(shared.subjects()).toEqual([]);
        advance(SocketPresence.DEFAULTS.heartbeatMs);
        a.presence.enter('room:1', 7);

        expect(shared.subjects()).toEqual(['ws.presence']);
        expect(await b.presence.members('room:1')).toEqual([7]);
    });

    it("logs a failing publish and still stops cleanly", () => {
        const [a]: Instance[] = cluster(1);
        const failure: Error = new Error('connection closed');
        a.presence.enter('room:1', 7);
        a.broker.filter = (): boolean => {
            throw failure;
        };

        expect(() => advance(SocketPresence.DEFAULTS.heartbeatMs)).not.toThrow();
        expect(() => a.presence.stop()).not.toThrow();

        expect(a.log.error).toHaveBeenCalledWith('Presence message "alive" failed:', failure);
        expect(a.log.error).toHaveBeenCalledWith('Presence message "bye" failed:', failure);
        expect(jest.getTimerCount()).toBe(0);
        expect(shared.subjects()).toEqual([]);
    });

    it("leaves no timers after stop", () => {
        const [a, b, c]: Instance[] = cluster(3);
        a.presence.enter('room:1', 7);
        b.presence.enter('room:1', 3);
        a.presence.exit('room:1', 7);
        c.presence.enter('room:2', 5);
        c.presence.stop();
        c.presence.stop();
        expect(jest.getTimerCount()).toBeGreaterThan(0);

        a.presence.stop();
        b.presence.stop();
        b.presence.exit('room:1', 3);

        expect(jest.getTimerCount()).toBe(0);
        expect(shared.subjects()).toEqual([]);
    });
});
