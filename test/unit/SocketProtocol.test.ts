import {SocketBusEvent, SocketProtocol} from "../../src/infrastructure/Server/socket/SocketProtocol";
import {SocketRefusalError} from "../../src/errors/ApplicationError/SocketRefusalError";

describe("socket protocol", () => {
    it("reads channel names, with the bare personal channel as its only name", () => {
        expect(SocketProtocol.parseChannel('order:12')).toEqual({type: 'order', key: '12'});
        expect(SocketProtocol.parseChannel('ticket:a_B-9')).toEqual({type: 'ticket', key: 'a_B-9'});
        expect(SocketProtocol.parseChannel('user')).toEqual({type: 'user', key: ''});
        for (const name of ['user:42', 'Order:1', 'order:', 'order:a b', 'order:1.2', 'order:>', `order:${'a'.repeat(65)}`, 42, null]) {
            expect([name, SocketProtocol.parseChannel(name)]).toEqual([name, null]);
        }
    });

    it("tells channel types, event types and refusal codes from the rest", () => {
        expect(SocketProtocol.isChannelType('ticket')).toBe(true);
        expect(SocketProtocol.isChannelType('user')).toBe(false);
        expect(SocketProtocol.isChannelType('Order')).toBe(false);
        expect(SocketProtocol.isEventType('notes.message')).toBe(true);
        expect(SocketProtocol.isEventType('Notes')).toBe(false);
        expect(SocketProtocol.isRefusalCode('too_fast')).toBe(true);
        expect(SocketProtocol.isRefusalCode('Bad')).toBe(false);
    });

    it("writes the frames of version 1, with data in an ack only when there is some", () => {
        expect(SocketProtocol.frames.hello(42)).toBe('{"op":"hello","v":1,"user":42}');
        expect(SocketProtocol.frames.ack('7')).toBe('{"op":"ack","id":"7"}');
        expect(SocketProtocol.frames.ack('7', {n: 1})).toBe('{"op":"ack","id":"7","d":{"n":1}}');
        expect(SocketProtocol.frames.ack('7', null)).toBe('{"op":"ack","id":"7","d":null}');
        expect(SocketProtocol.frames.event('order:12', 'watchers', {count: 2})).toBe('{"op":"event","ch":"order:12","t":"watchers","d":{"count":2}}');
        expect(SocketProtocol.frames.error('forbidden', {ch: 'order:12', id: null})).toBe('{"op":"error","code":"forbidden","ch":"order:12"}');
    });

    it("reads client frames and refuses anything else", () => {
        expect(SocketProtocol.parseClientFrame('{"op":"sub","ch":"order:1"}')).toEqual({op: 'sub', ch: 'order:1'});
        expect(SocketProtocol.parseClientFrame('{"op":"send","ch":"order:1","t":"x","id":"a b"}')).toEqual({op: 'send', ch: 'order:1', t: 'x', d: null, id: null});
        expect(SocketProtocol.parseClientFrame('not json')).toBeNull();
        expect(SocketProtocol.parseClientFrame('[1]')).toBeNull();
        expect(SocketProtocol.parseClientFrame('{"op":"jump"}')).toBeNull();
    });

    it("carries the excluded connection through the broker only when there is one", () => {
        expect(SocketProtocol.encodeBusEvent('notes.message', {a: 1}, null)).toBe('{"t":"notes.message","d":{"a":1}}');
        const decoded: SocketBusEvent | null = SocketProtocol.decodeBusEvent(SocketProtocol.encodeBusEvent('notes.message', {a: 1}, 'abc'));
        expect(decoded).toEqual({t: 'notes.message', d: {a: 1}, x: 'abc'});
        expect(SocketProtocol.decodeBusEvent('{"t":"x"}')).toEqual({t: 'x', d: null, x: null});
        expect(SocketProtocol.decodeBusEvent('garbage')).toBeNull();
        expect(SocketProtocol.decodeBusEvent('{"t":"Bad Type"}')).toBeNull();
    });

    it("names broker subjects with the application prefix", () => {
        expect(SocketProtocol.subject('ws', 'order', '12')).toBe('ws.order.12');
        expect(SocketProtocol.personalSubject('app', 42)).toBe('app.user.42');
    });

    it("accepts only refusal codes the client can rely on", () => {
        expect(new SocketRefusalError('too_fast').code).toBe('too_fast');
        expect(new SocketRefusalError('blocked', 'Blocked until Friday').message).toBe('Blocked until Friday');
        expect(() => new SocketRefusalError('Too Fast')).toThrow();
    });
});
