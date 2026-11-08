import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class GatewayTimeoutError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.GATEWAY_TIMEOUT, response);
        this.name = 'GatewayTimeoutError';
    }
}