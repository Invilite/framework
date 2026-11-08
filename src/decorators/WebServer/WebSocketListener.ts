import 'reflect-metadata';

export const WebSocketListener: (path: string) => MethodDecorator = (path: string): MethodDecorator => {
    const metadataKey: string = 'WebSocketHandlers';
    return (target: object, propertyKey: string | symbol): void => {
        const routes: any[] = Reflect.getOwnMetadata(metadataKey, target.constructor) || [];
        routes.push({ path, function: propertyKey.toString() });
        Reflect.defineMetadata(metadataKey, routes, target.constructor);
    };
};