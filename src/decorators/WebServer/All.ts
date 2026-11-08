import 'reflect-metadata';
import {RegisterRouteMetadata} from "../../infrastructure/Server/RegisterRouteMetadata";
import {RequestType} from "../../types/enums/RequestType";

export const All: (path: string) => MethodDecorator = (path: string): MethodDecorator => {
    return RegisterRouteMetadata(path, RequestType.all);
};