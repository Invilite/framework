import {IncomingMessage} from "http";
import {AbstractSocketController} from "../../../../../src/controllers/AbstractSocketController";
import {AbstractSocketEndpoint} from "../../../../../src/controllers/AbstractSocketEndpoint";
import {SocketChannel, SocketEndpoint} from "../../../../../src/decorators/WebServer";

@SocketEndpoint('/socket')
export class RoomPresenceSocketEndpoint extends AbstractSocketEndpoint {
    public connect(_request: IncomingMessage): Record<string, unknown> {
        return {};
    }
}

@SocketChannel('room', {presence: true})
export class RoomPresenceSocketController extends AbstractSocketController {
    public join(): boolean {
        return true;
    }
}
