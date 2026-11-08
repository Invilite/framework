import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class PreconditionRequiredError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.PRECONDITION_REQUIRED, response);
        this.name = 'PreconditionRequiredError';
    }
}