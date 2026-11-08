import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class MethodNotAllowedError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.METHOD_NOT_ALLOWED, response);
        this.name = 'MethodNotAllowedError';
    }
}