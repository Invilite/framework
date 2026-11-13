import {Logger} from "@invilite/logger";
import {HrTimer} from "../../../../utils/HrTimer";
import {SecretPaths} from "../../../../utils/SecretPaths";
import {NextFunction, Request, Response} from "express";
import {ExtendedRequest} from "../../../../models/ExtendedRequest";

export function LoggerMiddleware(logger: Logger) {
    return (request: Request, response: Response, next: NextFunction) => {
        const extendedRequest: ExtendedRequest = (request as ExtendedRequest);
        const requestTimer: () => number = HrTimer.startTimer();
        const requestMethod: string = request.method.toUpperCase();
        const referrer: string | undefined = request.headers.referer || request.get('referer');
        const path: string = SecretPaths.redact(request.path);
        const redactedReferrer: string | undefined =
            referrer === undefined ? undefined : SecretPaths.redact(referrer);

        extendedRequest.logger = logger.clone({
            requestId: extendedRequest.requestId
        })

        if (request.path !== '/api/status/health') {
            extendedRequest.logger.info(`${requestMethod} ${path} (${request.ip})${redactedReferrer ? ` [Referrer: ${redactedReferrer}]` : ''}`);
        }

        response.once('finish', () => {
            const duration: number = requestTimer();
            if (request.path !== '/api/status/health') {
                extendedRequest.logger.info(`${response.statusCode} ${response.statusMessage} (${duration}ms)`);
            }
        });

        next();
    }
}