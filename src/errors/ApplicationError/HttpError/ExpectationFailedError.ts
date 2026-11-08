import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class ExpectationFailedError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.EXPECTATION_FAILED, response);
        this.name = 'ExpectationFailedError';
    }
}