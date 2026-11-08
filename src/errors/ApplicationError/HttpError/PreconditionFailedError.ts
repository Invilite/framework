import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class PreconditionFailedError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.PRECONDITION_FAILED, response);
        this.name = 'PreconditionFailedError';
    }
}