import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class RequestURITooLongError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.REQUEST_URI_TOO_LONG, response);
        this.name = 'URITooLongError';
    }
}