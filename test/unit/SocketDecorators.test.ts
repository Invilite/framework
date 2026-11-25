import {IncomingMessage} from "http";
import ServiceContainer from "../../src/infrastructure/ServiceContainer";
import {AbstractSocketController} from "../../src/controllers/AbstractSocketController";
import {AbstractSocketEndpoint} from "../../src/controllers/AbstractSocketEndpoint";
import {
    readSocketChannel,
    readSocketEndpoint,
    readSocketMessages,
    SocketChannel,
    SocketEndpoint,
    SocketMessage,
} from "../../src/decorators/WebServer";
import {SocketContext} from "../../src/types/interfaces/SocketContext";

@SocketEndpoint('/socket')
class SiteSocket extends AbstractSocketEndpoint {
    public connect(_request: IncomingMessage): Record<string, unknown> {
        return {};
    }

    public container(): ServiceContainer {
        return this.serviceContainer;
    }
}

@SocketChannel('ticket')
class TicketChannel extends AbstractSocketController {
    public join(_context: SocketContext): boolean {
        return true;
    }

    @SocketMessage('editing')
    public editing(): void {
    }

    @SocketMessage('delivered')
    public delivered(): void {
    }

    public container(): ServiceContainer {
        return this.serviceContainer;
    }
}

@SocketChannel('room', {lossy: true, endpoint: '/admin'})
class RoomChannel extends AbstractSocketController {
    public join(): boolean {
        return true;
    }
}

@SocketChannel('room', {presence: true})
class PresentRoomChannel extends AbstractSocketController {
    public join(): boolean {
        return true;
    }
}

@SocketChannel('order')
class OrderChannel extends AbstractSocketController {
    public join(): boolean {
        return true;
    }
}

describe("socket decorators", () => {
    it("reads the presence option, off by default", () => {
        expect(readSocketChannel(PresentRoomChannel)?.presence).toBe(true);
        expect(readSocketChannel(OrderChannel)?.presence).toBe(false);
    });

    it("record the endpoint, the channels and the messages of each class", () => {
        expect(readSocketEndpoint(SiteSocket)).toEqual({path: '/socket'});
        expect(readSocketEndpoint(TicketChannel)).toBeNull();
        expect(readSocketChannel(TicketChannel)).toEqual({type: 'ticket', lossy: false, endpoint: null, presence: false});
        expect(readSocketChannel(RoomChannel)).toEqual({type: 'room', lossy: true, endpoint: '/admin', presence: false});
        expect(readSocketMessages(TicketChannel)).toEqual([{type: 'editing', method: 'editing'}, {type: 'delivered', method: 'delivered'}]);
        expect(readSocketMessages(RoomChannel)).toEqual([]);
    });

    it("give the bases the container from the controller parameters, as for HTTP controllers, and leave the hooks optional", () => {
        const container: ServiceContainer = new ServiceContainer();

        expect(new SiteSocket([container]).container()).toBe(container);
        expect(new TicketChannel([container]).container()).toBe(container);
        expect(new SiteSocket([container]).disconnect).toBeUndefined();
        expect(new TicketChannel([container]).leave).toBeUndefined();
    });
});
