import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class TooEarlyError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.TOO_EARLY, response);
        this.name = 'TooEarlyError';
    }
}