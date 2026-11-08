import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class UnavailableForLegalReasonsError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.UNAVAILABLE_FOR_LEGAL_REASONS, response);
        this.name = 'UnavailableForLegalReasonsError';
    }
}