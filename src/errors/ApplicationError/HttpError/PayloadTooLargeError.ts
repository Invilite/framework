import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class PayloadTooLargeError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.PAYLOAD_TOO_LARGE, response);
        this.name = 'ContentTooLargeError';
    }
}