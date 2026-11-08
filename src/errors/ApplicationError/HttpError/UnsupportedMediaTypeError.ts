import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class UnsupportedMediaTypeError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.UNSUPPORTED_MEDIA_TYPE, response);
        this.name = 'UnsupportedMediaTypeError';
    }
}