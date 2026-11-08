import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class ServiceUnavailableError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.SERVICE_UNAVAILABLE, response);
        this.name = 'ServiceUnavailableError';
    }
}