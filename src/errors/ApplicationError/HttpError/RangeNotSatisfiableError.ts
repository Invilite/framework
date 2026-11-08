import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";
import HttpError from "./index";

export class RangeNotSatisfiableError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.REQUESTED_RANGE_NOT_SATISFIABLE, response);
        this.name = 'RangeNotSatisfiableError';
    }
}