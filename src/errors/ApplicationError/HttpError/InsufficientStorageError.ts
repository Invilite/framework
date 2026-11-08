import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class InsufficientStorageError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.INSUFFICIENT_STORAGE, response);
        this.name = 'InsufficientStorageError';
    }
}