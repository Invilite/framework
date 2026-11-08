import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class ProxyAuthenticationRequiredError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.PROXY_AUTHENTICATION_REQUIRED, response);
        this.name = 'ProxyAuthenticationRequiredError';
    }
}