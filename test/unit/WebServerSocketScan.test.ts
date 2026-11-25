import http from "http";
import path from "path";
import express from "express";
import {IncomingMessage} from "http";
import {Logger} from "@invilite/logger";
import WebServer from "../../src/infrastructure/Server/WebServer";
import {SocketRegistry, SocketRegistryContext} from "../../src/infrastructure/Server/SocketRegistry";
import {AbstractSocketController} from "../../src/controllers/AbstractSocketController";
import {AbstractSocketEndpoint} from "../../src/controllers/AbstractSocketEndpoint";
import {SocketChannel, SocketEndpoint, SocketMessage} from "../../src/decorators/WebServer";
import {AuthService} from "../../src/services/AuthService";
import {MemorySocketBroker} from "../../src/services/Socket/MemorySocketBroker";
import {SocketPublisher} from "../../src/services/Socket/SocketPublisher";
import {SocketPresence} from "../../src/services/Socket/SocketPresence";
import {SocketPresenceChange} from "../../src/types/interfaces/SocketPresenceChange";

const authService: AuthService = new AuthService('HS256', 'scan-secret', 'scan-secret', 'socket-scan-test');

@SocketEndpoint('/socket')
class Endpoint extends AbstractSocketEndpoint {
    public connect(_request: IncomingMessage): Record<string, unknown> {
        return {};
    }
}

@SocketEndpoint('/socket')
class SameEndpoint extends Endpoint {
}

@SocketEndpoint('/other')
class OtherEndpoint extends Endpoint {
}

@SocketEndpoint('no-slash')
class BadPathEndpoint extends Endpoint {
}

@SocketEndpoint('/')
class RootPathEndpoint extends Endpoint {
}

@SocketEndpoint('/ws/')
class TrailingSlashEndpoint extends Endpoint {
}

@SocketEndpoint('/a//b')
class DoubleSlashEndpoint extends Endpoint {
}

@SocketEndpoint('/plain')
class PlainEndpoint {
}

@SocketChannel('room')
class Room extends AbstractSocketController {
    public join(): boolean {
        return true;
    }
}

@SocketChannel('room')
class SecondRoom extends Room {
}

@SocketChannel('room', {endpoint: '/nowhere'})
class LostRoom extends Room {
}

@SocketChannel('user')
class PersonalRoom extends Room {
}

@SocketChannel('Room')
class UpperRoom extends Room {
}

@SocketChannel('plain')
class PlainChannel {
}

@SocketChannel('room', {presence: true, endpoint: '/socket'})
class PresentRoom extends AbstractSocketController {
    public static readonly created: PresentRoom[] = [];

    public readonly changes: {channel: string; change: SocketPresenceChange}[] = [];

    public constructor() {
        super();
        PresentRoom.created.push(this);
    }

    public join(): boolean {
        return true;
    }

    public presenceChanged(channel: string, change: SocketPresenceChange): void {
        this.changes.push({channel, change});
    }
}

@SocketChannel('room', {presence: true, endpoint: '/other'})
class OtherPresentRoom extends PresentRoom {
}

class Messages extends AbstractSocketController {
    public join(): boolean {
        return true;
    }

    @SocketMessage('notes.message')
    public message(): void {
    }
}

@SocketChannel('notes')
class BadMessage extends AbstractSocketController {
    public join(): boolean {
        return true;
    }

    @SocketMessage('Notes Message')
    public message(): void {
    }
}

@SocketChannel('notes')
class TwiceMessage extends AbstractSocketController {
    public join(): boolean {
        return true;
    }

    @SocketMessage('notes.message')
    public first(): void {
    }

    @SocketMessage('notes.message')
    public second(): void {
    }
}

function context(withSocket: boolean = true): SocketRegistryContext {
    return {
        server: http.createServer(),
        express: express(),
        logger: new Logger(),
        authService,
        options: withSocket ? {publisher: new SocketPublisher(new MemorySocketBroker())} : undefined,
    };
}

function build(classes: (abstract new (...parameters: never[]) => object)[], withSocket: boolean = true, listenerPaths: string[] = []): void {
    const registry: SocketRegistry = new SocketRegistry();
    for (const target of classes) {
        registry.collect(target, target.name, `${target.name}.ts`);
    }
    registry.build({...context(withSocket), listenerPaths: new Set<string>(listenerPaths)});
    registry.close();
}

describe("socket classes found by the WebServer scan", () => {
    beforeAll(() => {
        process.env.COOKIE_SECRET = process.env.COOKIE_SECRET ?? 'test-cookie-secret';
        process.env.HOST_NAME = process.env.HOST_NAME ?? 'http://localhost:8080';
    });

    it("builds an endpoint with its channels", () => {
        expect(() => build([Endpoint, Room])).not.toThrow();
        expect(() => build([Endpoint, OtherEndpoint, LostRoom])).toThrow(/LostRoom.*no @SocketEndpoint at "\/nowhere"/);
    });

    it.each([
        ['an endpoint without WebServerOptions.socket', [Endpoint], false, /needs WebServerOptions.socket/],
        ['two endpoints under one path', [Endpoint, SameEndpoint], true, /SameEndpoint.*second @SocketEndpoint at "\/socket"/],
        ['an endpoint path without a slash', [BadPathEndpoint], true, /invalid endpoint path/],
        ['the root as an endpoint path', [RootPathEndpoint], true, /invalid endpoint path/],
        ['an endpoint path ending with a slash', [TrailingSlashEndpoint], true, /invalid endpoint path/],
        ['an endpoint path with an empty segment', [DoubleSlashEndpoint], true, /invalid endpoint path/],
        ['an endpoint without its base class', [PlainEndpoint], true, /must extend AbstractSocketEndpoint/],
        ['a channel without an endpoint', [Room], true, /needs a @SocketEndpoint/],
        ['a channel among several endpoints without naming one', [Endpoint, OtherEndpoint, Room], true, /must name its endpoint/],
        ['two channels of one type', [Endpoint, Room, SecondRoom], true, /SecondRoom.*already registered/],
        ['the personal channel type', [Endpoint, PersonalRoom], true, /invalid channel type "user"/],
        ['a type outside the protocol', [Endpoint, UpperRoom], true, /invalid channel type "Room"/],
        ['a channel without its base class', [Endpoint, PlainChannel], true, /must extend AbstractSocketController/],
        ['messages without @SocketChannel', [Endpoint, Messages], true, /needs @SocketChannel/],
        ['a message type outside the protocol', [Endpoint, BadMessage], true, /invalid message type/],
        ['two methods for one message', [Endpoint, TwiceMessage], true, /second @SocketMessage/],
    ])("refuses %s", (_case: string, classes: (abstract new (...parameters: never[]) => object)[], withSocket: boolean, error: RegExp) => {
        expect(() => build(classes, withSocket)).toThrow(error);
    });

    it("refuses an endpoint on a path a @WebSocketListener already serves", () => {
        expect(() => build([Endpoint], true, ['/socket'])).toThrow(/already a @WebSocketListener path/);
        expect(() => build([Endpoint], true, ['/other'])).not.toThrow();
    });

    it("stops the start for a presence channel without options.socket.presence", () => {
        expect(() => build([Endpoint, PresentRoom])).toThrow(/PresentRoom.*needs WebServerOptions\.socket\.presence/);
    });

    it("refuses one presence channel type on two endpoints", () => {
        const presence: SocketPresence = new SocketPresence(new SocketPublisher(new MemorySocketBroker()));
        const registry: SocketRegistry = new SocketRegistry();
        for (const target of [Endpoint, OtherEndpoint, PresentRoom, OtherPresentRoom]) {
            registry.collect(target, target.name, `${target.name}.ts`);
        }
        const base: SocketRegistryContext = context();
        const options: NonNullable<SocketRegistryContext['options']> = {...(base.options as NonNullable<SocketRegistryContext['options']>), presence};

        expect(() => registry.build({...base, options})).toThrow(/OtherPresentRoom.*already/);
        registry.close();
    });

    describe("with presence", () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it("routes presenceChanged to the channel controller", () => {
            const presence: SocketPresence = new SocketPresence(new SocketPublisher(new MemorySocketBroker()));
            const registry: SocketRegistry = new SocketRegistry();
            for (const target of [Endpoint, PresentRoom]) {
                registry.collect(target, target.name, `${target.name}.ts`);
            }
            const base: SocketRegistryContext = context();
            const options: NonNullable<SocketRegistryContext['options']> = {...(base.options as NonNullable<SocketRegistryContext['options']>), presence};
            registry.build({...base, options});
            jest.advanceTimersByTime(SocketPresence.DEFAULTS.syncWaitMs);

            presence.enter('room:1', 7);
            registry.close();

            const instance: PresentRoom = PresentRoom.created[PresentRoom.created.length - 1];
            expect(instance.changes).toEqual([{channel: 'room:1', change: {joined: [7], left: []}}]);
        });
    });

    it("stops the WebServer instead of logging the mistake like a broken HTTP controller", () => {
        expect(() => new WebServer(new Logger(), {
            trustProxy: false,
            controllersPath: path.resolve(__dirname, 'fixtures/sockets/broken'),
            socket: {publisher: new SocketPublisher(new MemorySocketBroker())},
        }, authService)).toThrow(/OrphanSocketController/);
    });
});
