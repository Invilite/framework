import ServiceContainer from "../../infrastructure/ServiceContainer";
import {AbstractLogger} from "../interfaces/AbstractLogger";
import {AbstractService} from "../../infrastructure/Service/AbstractService";

/** What every service factory gets; an application may pass a richer object, services take the rest from the container. */
export interface ServiceContext {
    logger: AbstractLogger;
    container: ServiceContainer;
}

/** A @Service class as the registry sees it: its static factory, called once with the application context. */
export interface ServiceClass<TContext extends ServiceContext> {
    readonly name: string;
    readonly prototype: AbstractService;
    create(context: TContext): AbstractService;
}

export type ServiceStatus = 'registered' | 'created' | 'initialized' | 'shut down' | 'failed';

export interface ServiceRegistration {
    name: string;
    className: string;
    modulePath: string | null;
    status: ServiceStatus;
}
