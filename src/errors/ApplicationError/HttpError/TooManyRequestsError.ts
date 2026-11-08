import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class TooManyRequestsError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.TOO_MANY_REQUESTS, response);
        this.name = 'TooManyRequestsError';
    }
}