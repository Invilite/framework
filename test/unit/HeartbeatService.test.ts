import {KV, Msg, NatsConnection} from "nats";
import {NatsError} from "nats/lib/nats-base-client/core";
import HeartbeatService from "../../src/services/HeartbeatService";

type SubscriptionCallback = (error: NatsError | null, message: Msg) => void;

interface FakeKv {
    put: jest.Mock;
    get: jest.Mock;
}

interface FakeNats {
    jetstream: jest.Mock;
    publish: jest.Mock;
    subscribe: jest.Mock;
    callback: SubscriptionCallback | null;
}

function fakeKv(): FakeKv {
    return {
        put: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue(null),
    };
}

function buildNats(kvCreate: jest.Mock): FakeNats {
    const nats: FakeNats = {
        jetstream: jest.fn(() => ({views: {kv: kvCreate}})),
        publish: jest.fn(),
        subscribe: jest.fn((_subject: string, options: {callback: SubscriptionCallback}): {isClosed: () => boolean; unsubscribe: jest.Mock} => {
            nats.callback = options.callback;
            return {isClosed: (): boolean => false, unsubscribe: jest.fn()};
        }),
        callback: null,
    };
    return nats;
}

function buildService(nats: FakeNats): HeartbeatService {
    return new HeartbeatService(nats as unknown as NatsConnection, 'ns');
}

describe('HeartbeatService', () => {
    it('creates the KV bucket lazily, not in the constructor', (): void => {
        const kvCreate: jest.Mock = jest.fn();
        buildService(buildNats(kvCreate));

        expect(kvCreate).not.toHaveBeenCalled();
    });

    it('retries creating the KV bucket after a failed attempt', async (): Promise<void> => {
        const kv: FakeKv = fakeKv();
        const bootError: Error = new Error('JetStream unavailable');
        const kvCreate: jest.Mock = jest.fn().mockRejectedValueOnce(bootError).mockResolvedValueOnce(kv);
        const service: HeartbeatService = buildService(buildNats(kvCreate));

        await expect(service.beat('a')).rejects.toBe(bootError);
        await expect(service.beat('a')).resolves.toBeUndefined();

        expect(kvCreate).toHaveBeenCalledTimes(2);
        expect(kv.put).toHaveBeenCalledWith('ns.a', expect.any(Uint8Array));
    });

    it('ignores malformed heartbeat messages in the watch callback', async (): Promise<void> => {
        const kv: FakeKv = fakeKv();
        const nats: FakeNats = buildNats(jest.fn().mockResolvedValue(kv));
        const service: HeartbeatService = buildService(nats);
        const listener: jest.Mock = jest.fn();

        const unwatch: () => void = await service.watch('a', listener);
        const callback: SubscriptionCallback = nats.callback as SubscriptionCallback;

        expect((): void => callback(null, {string: (): string => 'not-json'} as Msg)).not.toThrow();
        expect((): void => callback(null, {string: (): string => JSON.stringify({alive: 'yes'})} as Msg)).not.toThrow();
        expect(listener).not.toHaveBeenCalled();

        callback(null, {string: (): string => JSON.stringify({alive: true})} as Msg);
        expect(listener).toHaveBeenCalledWith(true);

        unwatch();
    });
});
