import 'reflect-metadata';

export const METADATA_SERVICE_NAME = 'ServiceName';

/**
 * Class decorator marking a live service: a singleton with a lifecycle (timer, subscription, queue, shared cache or
 * configured connector) that extends AbstractService. ServiceRegistry discovers it, calls its static create(context)
 * factory, registers the instance in ServiceContainer under the given name (default: class name) and drives
 * start()/stop(). Stateless helpers are not services in this sense and stay on `new`.
 *
 * @example @Service()
 * @example @Service('CustomName')
 */
export const Service = (name?: string): ClassDecorator => {
    return (target: Function): void => {
        Reflect.defineMetadata(METADATA_SERVICE_NAME, name ?? target.name, target);
    };
};

/** Own metadata only - a subclass of a service is not a service by inheritance. */
export function getServiceName(target: Function): string | undefined {
    return Reflect.getOwnMetadata(METADATA_SERVICE_NAME, target);
}
