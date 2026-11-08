import {IncomingMessage} from "http";
import ServiceContainer from "../infrastructure/ServiceContainer";
import {SocketConnection} from "../types/interfaces/SocketConnection";

/**
 * Base of a @SocketEndpoint class: decides who connects and what the application keeps about the connection.
 * WebServer builds it with the controller parameters, like every controller.
 */
export abstract class AbstractSocketEndpoint<TAttributes extends object = Record<string, unknown>> {
    protected readonly serviceContainer: ServiceContainer;

    public constructor(controllerParameters?: unknown[]) {
        this.serviceContainer = controllerParameters?.[0] as ServiceContainer;
    }

    /**
     * Called before the upgrade, after the authentication middleware (`request.auth` as over HTTP) and @RequiresAuth
     * of this method. Returns the attributes of the connection, or null to refuse it with 403.
     */
    public abstract connect(request: IncomingMessage): TAttributes | null | Promise<TAttributes | null>;

    /** Called once when the connection is gone, after `leave` of all its channels. */
    public disconnect?(connection: SocketConnection<TAttributes>): void | Promise<void>;
}
