import {MemorySocketBroker} from "../../src/services/Socket/MemorySocketBroker";
import {SocketPublisher} from "../../src/services/Socket/SocketPublisher";

function collect(broker: MemorySocketBroker, subject: string): string[] {
    const payloads: string[] = [];
    broker.subscribe(subject, (payload: string): void => {
        payloads.push(payload);
    }, (): void => undefined);

    return payloads;
}

describe("socket publisher", () => {
    it("publishes to a channel subject, naming the excluded connection only when asked", () => {
        const broker: MemorySocketBroker = new MemorySocketBroker();
        const received: string[] = collect(broker, 'ws.order.12');
        const publisher: SocketPublisher = new SocketPublisher(broker);

        publisher.publish('order:12', 'notes.message', {a: 1});
        publisher.publish('order:12', 'notes.editing', null, {except: 'abc'});

        expect(received).toEqual(['{"t":"notes.message","d":{"a":1}}', '{"t":"notes.editing","d":null,"x":"abc"}']);
    });

    it("publishes to an account's personal channel and under the application prefix", () => {
        const broker: MemorySocketBroker = new MemorySocketBroker();
        const personal: string[] = collect(broker, 'app.user.42');
        const channel: string[] = collect(broker, 'app.order.12');
        const publisher: SocketPublisher = new SocketPublisher(broker, {subjectPrefix: 'app'});

        publisher.toUser(42, 'notification', {id: 3});
        publisher.publish('order:12', 'watchers', {count: 1});

        expect(personal).toEqual(['{"t":"notification","d":{"id":3}}']);
        expect(channel).toEqual(['{"t":"watchers","d":{"count":1}}']);
        expect(publisher.subjectPrefix).toBe('app');
        expect(publisher.broker).toBe(broker);
    });

    it("refuses what no client could receive", () => {
        const publisher: SocketPublisher = new SocketPublisher(new MemorySocketBroker());

        expect(() => publisher.publish('user', 'x', null)).toThrow();
        expect(() => publisher.publish('user:1', 'x', null)).toThrow();
        expect(() => publisher.publish('order:1.2', 'x', null)).toThrow();
        expect(() => publisher.publish('order:1', 'Bad Type', null)).toThrow();
        expect(() => publisher.toUser(0, 'x', null)).toThrow();
        expect(() => publisher.toUser(1.5, 'x', null)).toThrow();
        expect(() => publisher.publish('order:1', 'notes.message', {text: 'a'.repeat(70 * 1024)})).toThrow(/over 65536/);
        expect(() => new SocketPublisher(new MemorySocketBroker(), {subjectPrefix: 'a.b'})).toThrow();
    });

    it("lets the memory broker end a subscription the way a real broker does", () => {
        const broker: MemorySocketBroker = new MemorySocketBroker();
        const failures: string[] = [];
        broker.subscribe('ws.order.1', (): void => undefined, (error: Error): void => {
            failures.push(error.message);
        });

        broker.fail('ws.order.1');

        expect(failures).toHaveLength(1);
        expect(broker.subjects()).toEqual([]);
    });
});
