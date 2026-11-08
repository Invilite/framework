import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class HTTPVersionNotSupportedError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.HTTP_VERSION_NOT_SUPPORTED, response);
        this.name = 'HTTPVersionNotSupportedError';
    }
}