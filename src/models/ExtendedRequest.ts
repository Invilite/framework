import {JwtPayload} from "jsonwebtoken";
import {Request} from "express";
import {AbstractLogger} from "../types/interfaces/AbstractLogger";
import {AuthService} from "../services/AuthService";

export interface ExtendedRequest extends Request {
    authService: AuthService;
    auth?: JwtPayload;
    logger: AbstractLogger;
    requestId?: string;
    /** Set by the @Render decorator before the controller method runs: this route responds with HTML via response.render(). Distinguishes SSR vs JSON in the terminal 500 handler. */
    renderRoute?: boolean;
    /** Set by a controller that pipes the response body itself (e.g. streams a Readable) and returns undefined: requestHandler must not coerce the return value into a 204, because writableEnded is still false while the pipe is in flight. */
    selfResponding?: boolean;
}