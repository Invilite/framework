import {AbstractLogger} from "../../src/types/interfaces/AbstractLogger";
import {AmqpConnection} from "../../src/infrastructure/Queue/AmqpConnection";

const logger: AbstractLogger = {
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

type FakeAmqp = {connect: jest.Mock};

function build(amqp: FakeAmqp): AmqpConnection {
    const connection: AmqpConnection = new AmqpConnection({
        host: 'localhost',
        port: 5672,
        user: 'guest',
        password: 'guest',
        reconnectDelay: 100,
    }, logger);
    (connection as unknown as {amqp: FakeAmqp}).amqp = amqp;
    return connection;
}

describe('AmqpConnection reconnect notification', () => {
    beforeEach((): void => {
        jest.useFakeTimers();
    });

    afterEach((): void => {
        jest.useRealTimers();
    });

    it('does not notify consumers when a reconnect attempt fails', async (): Promise<void> => {
        const amqp: FakeAmqp = {connect: jest.fn().mockRejectedValue(new Error('down'))};
        const connection: AmqpConnection = build(amqp);
        const onReconnect: jest.Mock = jest.fn();
        connection.onReconnect(onReconnect);

        await connection.connect();
        expect(connection.isConnected()).toBe(false);

        await jest.advanceTimersByTimeAsync(100);

        expect(amqp.connect).toHaveBeenCalledTimes(2);
        expect(onReconnect).not.toHaveBeenCalled();

        await connection.close();
    });

    it('notifies consumers once after a successful reconnect', async (): Promise<void> => {
        const fakeConnection = {on: jest.fn(), close: jest.fn().mockResolvedValue(undefined)};
        const amqp: FakeAmqp = {
            connect: jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(fakeConnection),
        };
        const connection: AmqpConnection = build(amqp);
        const onReconnect: jest.Mock = jest.fn();
        connection.onReconnect(onReconnect);

        await connection.connect();
        await jest.advanceTimersByTimeAsync(100);

        expect(connection.isConnected()).toBe(true);
        expect(onReconnect).toHaveBeenCalledTimes(1);

        await connection.close();
    });
});
