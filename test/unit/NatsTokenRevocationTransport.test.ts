import {Events} from "nats";
import NatsTokenRevocationTransport, {
    REVOCATION_CONFIRM_TIMEOUT_MS,
    TOKEN_REVOCATION_SUBJECT,
} from "../../src/services/NatsTokenRevocationTransport";

interface FakeStatus {
    type: string;
    data: string;
}

class FakeNatsConnection {
    public published: string[] = [];
    public flush: jest.Mock = jest.fn(async (): Promise<void> => undefined);
    private readonly statuses: FakeStatus[] = [];
    private wake: (() => void) | null = null;
    private closed: boolean = false;

    public publish(subject: string): void {
        this.published.push(subject);
    }

    public emitStatus(status: FakeStatus): void {
        this.statuses.push(status);
        this.wake?.();
    }

    public close(): void {
        this.closed = true;
        this.wake?.();
    }

    public status(): AsyncIterable<FakeStatus> {
        const connection: FakeNatsConnection = this;
        return {
            async *[Symbol.asyncIterator](): AsyncGenerator<FakeStatus> {
                while (true) {
                    while (connection.statuses.length > 0) {
                        yield connection.statuses.shift() as FakeStatus;
                    }
                    if (connection.closed) {
                        return;
                    }
                    await new Promise<void>((resolve: () => void): void => {
                        connection.wake = resolve;
                    });
                }
            },
        };
    }
}

async function settle(): Promise<void> {
    for (let round: number = 0; round < 5; round++) {
        await Promise.resolve();
    }
}

describe("NatsTokenRevocationTransport", () => {
    afterEach((): void => {
        jest.useRealTimers();
    });

    it("publishRevocation publishes on the broadcast subject and waits for the server confirmation", async () => {
        const connection: FakeNatsConnection = new FakeNatsConnection();
        const transport: NatsTokenRevocationTransport = new NatsTokenRevocationTransport(connection as any);

        await transport.publishRevocation([7], new Date());

        expect(connection.published).toEqual([TOKEN_REVOCATION_SUBJECT]);
        expect(connection.flush).toHaveBeenCalledTimes(1);
    });

    it("publishRevocation rejects when the confirmation fails", async () => {
        const connection: FakeNatsConnection = new FakeNatsConnection();
        connection.flush.mockRejectedValue(new Error('connection closed'));
        const transport: NatsTokenRevocationTransport = new NatsTokenRevocationTransport(connection as any);

        await expect(transport.publishRevocation([7], new Date())).rejects.toThrow('connection closed');
    });

    it("publishRevocation rejects when the confirmation does not arrive in time", async () => {
        jest.useFakeTimers();
        const connection: FakeNatsConnection = new FakeNatsConnection();
        connection.flush.mockImplementation((): Promise<void> => new Promise<void>((): void => undefined));
        const transport: NatsTokenRevocationTransport = new NatsTokenRevocationTransport(connection as any);

        const pending: Promise<void> = transport.publishRevocation([7], new Date());
        const assertion: Promise<void> = expect(pending).rejects.toThrow();
        jest.advanceTimersByTime(REVOCATION_CONFIRM_TIMEOUT_MS + 1);

        await assertion;
    });

    it("subscribeToReconnects calls the handler on reconnect events only", async () => {
        const connection: FakeNatsConnection = new FakeNatsConnection();
        const transport: NatsTokenRevocationTransport = new NatsTokenRevocationTransport(connection as any);
        const handler: jest.Mock = jest.fn();

        transport.subscribeToReconnects(handler);
        connection.emitStatus({type: Events.Disconnect, data: ''});
        connection.emitStatus({type: Events.Reconnect, data: ''});
        await settle();
        connection.close();
        await settle();

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("a failing reconnect handler does not stop later reconnects", async () => {
        const connection: FakeNatsConnection = new FakeNatsConnection();
        const transport: NatsTokenRevocationTransport = new NatsTokenRevocationTransport(connection as any);
        const handler: jest.Mock = jest.fn()
            .mockRejectedValueOnce(new Error('reload failed'))
            .mockResolvedValueOnce(undefined);

        transport.subscribeToReconnects(handler);
        connection.emitStatus({type: Events.Reconnect, data: ''});
        await settle();
        connection.emitStatus({type: Events.Reconnect, data: ''});
        await settle();

        expect(handler).toHaveBeenCalledTimes(2);
        connection.close();
        await settle();
    });

    it("stop() ends the reconnect watch", async () => {
        const connection: FakeNatsConnection = new FakeNatsConnection();
        const transport: NatsTokenRevocationTransport = new NatsTokenRevocationTransport(connection as any);
        const handler: jest.Mock = jest.fn();

        transport.subscribeToReconnects(handler);
        transport.stop();
        connection.emitStatus({type: Events.Reconnect, data: ''});
        await settle();

        expect(handler).not.toHaveBeenCalled();
        connection.close();
        await settle();
    });
});
