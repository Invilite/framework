import ServiceContainer from "../infrastructure/ServiceContainer";
import {SocketContext} from "../types/interfaces/SocketContext";

/**
 * Base of a @SocketChannel class: who may subscribe to a channel of its type and what its @SocketMessage methods do.
 * One instance serves every connection, so per-connection data lives in `context.state`, not in fields.
 */
export abstract class AbstractSocketController<TAttributes extends object = Record<string, unknown>> {
    protected readonly serviceContainer: ServiceContainer;

    public constructor(controllerParameters?: unknown[]) {
        this.serviceContainer = controllerParameters?.[0] as ServiceContainer;
    }

    /** On every subscription, also after a reconnect: true subscribes, false refuses, SocketRefusalError refuses with its code. */
    public abstract join(context: SocketContext<TAttributes>): boolean | Promise<boolean>;

    /** Once after every join that returned true: unsubscribe, disconnect or the server closing the connection. */
    public leave?(context: SocketContext<TAttributes>): void | Promise<void>;
}
