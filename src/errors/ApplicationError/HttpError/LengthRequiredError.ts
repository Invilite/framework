import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class LengthRequiredError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.LENGTH_REQUIRED, response);
        this.name = 'LengthRequiredError';
    }
}