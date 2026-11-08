import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class MisdirectedRequestError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.MISDIRECTED_REQUEST, response);
        this.name = 'MisdirectedRequestError';
    }
}