import {RequestType} from "../enums/RequestType";

export interface RouteDefinition {
    path: string,
    method: RequestType,
    function: string,
}