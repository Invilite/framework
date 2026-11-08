import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class NotImplementedError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.NOT_IMPLEMENTED, response);
        this.name = 'NotImplementedError';
    }
}