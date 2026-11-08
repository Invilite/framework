import {AbstractSocketController} from "../../../../../src/controllers/AbstractSocketController";
import {SocketChannel} from "../../../../../src/decorators/WebServer";

@SocketChannel('orphan')
export class OrphanSocketController extends AbstractSocketController {
    public join(): boolean {
        return true;
    }
}
