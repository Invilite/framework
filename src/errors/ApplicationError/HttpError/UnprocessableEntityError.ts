import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class UnprocessableEntityError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.UNPROCESSABLE_ENTITY, response);
        this.name = 'UnprocessableContentError';
    }
}