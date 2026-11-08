import {RequestType} from "../../types/enums/RequestType";
import {RouteDefinition} from "../../types/interfaces/RouteDefinition";

export function RegisterRouteMetadata(path: string, method: RequestType) {
    const metadataKey: string = 'Routes';
    return (target: object, propertyKey: string | symbol): void => {
        const routes: RouteDefinition[] = Reflect.getOwnMetadata(metadataKey, target.constructor) || [];

        routes.push({ path, method, function: propertyKey.toString() });

        Reflect.defineMetadata(metadataKey, routes, target.constructor);
    };
}