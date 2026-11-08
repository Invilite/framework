import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class PaymentRequiredError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.PAYMENT_REQUIRED, response);
        this.name = 'PaymentRequiredError';
    }
}