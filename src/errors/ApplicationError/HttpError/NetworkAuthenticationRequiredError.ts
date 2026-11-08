import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class NetworkAuthenticationRequiredError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.NETWORK_AUTHENTICATION_REQUIRED, response);
        this.name = 'NetworkAuthenticationRequiredError';
    }
}