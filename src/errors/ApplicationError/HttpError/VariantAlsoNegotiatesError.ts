import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class VariantAlsoNegotiatesError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.VARIANT_ALSO_NEGOTIATES, response);
        this.name = 'VariantAlsoNegotiatesError';
    }
}