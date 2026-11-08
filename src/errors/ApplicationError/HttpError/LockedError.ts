import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class LockedError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.LOCKED, response);
        this.name = 'LockedError';
    }
}