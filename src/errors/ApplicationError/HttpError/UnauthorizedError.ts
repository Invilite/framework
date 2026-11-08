import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class UnauthorizedError extends HttpError {
    public constructor(message: string, response?: string | Buffer, redirect?: string) {
        super(message, HttpStatusCodes.UNAUTHORIZED, response, redirect);
        this.name = 'UnauthorizedError';
    }
}