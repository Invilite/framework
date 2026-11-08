import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class LoopDetectedError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.LOOP_DETECTED, response);
        this.name = 'LoopDetectedError';
    }
}