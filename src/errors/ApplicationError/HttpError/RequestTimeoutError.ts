import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class RequestTimeoutError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.REQUEST_TIMEOUT, response);
        this.name = 'RequestTimeoutError';
    }
}