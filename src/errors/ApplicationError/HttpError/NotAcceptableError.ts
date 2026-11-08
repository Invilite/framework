import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class NotAcceptableError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.NOT_ACCEPTABLE, response);
        this.name = 'NotAcceptableError';
    }
}