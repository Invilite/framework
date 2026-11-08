import ServiceContainer from "../ServiceContainer";
import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {ServiceContext} from "../../types/types/ServiceTypes";

/**
 * Base of every live service (@Service). The default factory builds the service from the context alone - enough for
 * a service that takes what it needs from the container. A service with its own dependencies overrides `create`, so
 * unit tests can pass fakes to its constructor.
 *
 * initialize() throwing (or rejecting) is fatal for the application boot; a service able to recover on its own must
 * not throw - it logs and retries internally. shutdown() releases everything initialize() acquired.
 */
export abstract class AbstractService {
    protected readonly logger: AbstractLogger;
    protected readonly container: ServiceContainer;

    public constructor(context: ServiceContext) {
        this.logger = context.logger;
        this.container = context.container;
    }

    public static create(context: ServiceContext): AbstractService {
        // `this` is the class the registry calls it on, so a subclass without its own factory is built as itself.
        return new (this as unknown as new (context: ServiceContext) => AbstractService)(context);
    }

    /** Called once by the registry before the application serves anything: subscriptions, timers, connections. */
    public initialize(): void | Promise<void> {
    }

    /** Called once on the way down, in reverse order of initialization. */
    public shutdown(): void | Promise<void> {
    }
}
