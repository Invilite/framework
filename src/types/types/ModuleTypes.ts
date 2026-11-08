import ServiceContainer, {ContainerKey} from "../../infrastructure/ServiceContainer";
import {AbstractLogger} from "../interfaces/AbstractLogger";

export interface ModuleOptions {
    name: string;
    after?: string[];
}

export type ModuleContainer = Pick<ServiceContainer, 'register' | 'has'>;

export interface ModuleLookup {
    get<TModule extends object>(target: ContainerKey<TModule>): TModule;
}

export interface ModuleContext {
    logger: AbstractLogger;
    container: ModuleContainer;
    modules: ModuleLookup;
}

export type ModuleResources<TContext extends ModuleContext> = Omit<TContext, keyof ModuleContext>;

export interface ModuleClass<TContext extends ModuleContext> {
    readonly name: string;
    new (context: TContext): object;
}

export type ModuleStatus = 'registered' | 'created' | 'failed';

export interface ModuleRegistration {
    name: string;
    className: string;
    modulePath: string | null;
    after: string[];
    status: ModuleStatus;
}
