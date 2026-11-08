import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class RequestHeaderFieldsTooLargeError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.REQUEST_HEADER_FIELDS_TOO_LARGE, response);
        this.name = 'RequestHeaderFieldsTooLargeError';
    }
}