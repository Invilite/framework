import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class BadGatewayError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.BAD_GATEWAY, response);
        this.name = 'BadGatewayError';
    }
}