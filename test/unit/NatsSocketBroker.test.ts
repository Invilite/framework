import {Msg, NatsConnection} from "nats";
import {NatsError} from "nats/lib/nats-base-client/core";
import {NatsSocketBroker} from "../../src/services/Socket/NatsSocketBroker";

type SubscriptionCallback = (error: NatsError | null, message: Msg) => void;

interface FakeNats {
    subscribe: jest.Mock;
    callback: SubscriptionCallback | null;
}

function buildNats(): FakeNats {
    const nats: FakeNats = {
        subscribe: jest.fn((_subject: string, options: {callback: SubscriptionCallback}) => {
            nats.callback = options.callback;
            return {unsubscribe: jest.fn()};
        }),
        callback: null,
    };
    return nats;
}

function message(payload: string): Msg {
    return {data: new TextEncoder().encode(payload)} as Msg;
}

describe('NatsSocketBroker', () => {
    it('delivers the decoded payload to the subscriber', (): void => {
        const nats: FakeNats = buildNats();
        const broker: NatsSocketBroker = new NatsSocketBroker(nats as unknown as NatsConnection);
        const deliver: jest.Mock = jest.fn();
        const failed: jest.Mock = jest.fn();

        broker.subscribe('subject', deliver, failed);
        (nats.callback as SubscriptionCallback)(null, message('hello'));

        expect(deliver).toHaveBeenCalledWith('hello');
        expect(failed).not.toHaveBeenCalled();
    });

    it('routes a delivery error to the failure callback instead of throwing out of the subscription', (): void => {
        const nats: FakeNats = buildNats();
        const broker: NatsSocketBroker = new NatsSocketBroker(nats as unknown as NatsConnection);
        const failure: Error = new Error('consumer failed');
        const deliver: jest.Mock = jest.fn((): void => {
            throw failure;
        });
        const failed: jest.Mock = jest.fn();

        broker.subscribe('subject', deliver, failed);

        expect((): void => (nats.callback as SubscriptionCallback)(null, message('hello'))).not.toThrow();
        expect(failed).toHaveBeenCalledWith(failure);
    });

    it('normalizes a non-Error delivery failure before reporting it', (): void => {
        const nats: FakeNats = buildNats();
        const broker: NatsSocketBroker = new NatsSocketBroker(nats as unknown as NatsConnection);
        const deliver: jest.Mock = jest.fn((): void => {
            throw 'boom';
        });
        const failed: jest.Mock = jest.fn();

        broker.subscribe('subject', deliver, failed);
        (nats.callback as SubscriptionCallback)(null, message('hello'));

        const error: unknown = failed.mock.calls[0][0];
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('boom');
    });
});
