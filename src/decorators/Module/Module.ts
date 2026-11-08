import 'reflect-metadata';
import {ModuleOptions} from "../../types/types/ModuleTypes";

export const METADATA_MODULE_OPTIONS = 'ModuleOptions';

/**
 * Class decorator marking the single module of a domain: a class that assembles the domain objects in its constructor,
 * registers what controllers and services need in the container and exposes what other modules need as fields.
 * ModuleRegistry discovers it, creates it in `after` order and passes the module context. Modules have no lifecycle -
 * anything long-lived belongs to a @Service.
 */
export const Module = (options: ModuleOptions): ClassDecorator => {
    return (target: Function): void => {
        Reflect.defineMetadata(METADATA_MODULE_OPTIONS, options, target);
    };
};

/** Own metadata only - a subclass of a module is not a module by inheritance. */
export function getModuleOptions(target: Function): ModuleOptions | undefined {
    return Reflect.getOwnMetadata(METADATA_MODULE_OPTIONS, target);
}
