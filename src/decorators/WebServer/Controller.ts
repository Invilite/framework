import 'reflect-metadata';

export const Controller: (baseUrl?: string) => ClassDecorator = (baseUrl = ""): ClassDecorator => {
    return (target: any): void => {
        Reflect.defineMetadata('IsController', true, target);
        Reflect.defineMetadata('BaseUrl', baseUrl, target);

        // Since routes are set by our methods this should almost never be true (except when the controller has no methods)
        if (!Reflect.hasMetadata('Routes', target)) {
            Reflect.defineMetadata('Routes', [], target);
        }
    };
};