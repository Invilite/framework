import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class InternalServerErrorError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.INTERNAL_SERVER_ERROR, response);
        this.name = 'InternalServerErrorError';
    }
}