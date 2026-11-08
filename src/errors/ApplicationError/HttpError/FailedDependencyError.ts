import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class FailedDependencyError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.FAILED_DEPENDENCY, response);
        this.name = 'FailedDependencyError';
    }
}