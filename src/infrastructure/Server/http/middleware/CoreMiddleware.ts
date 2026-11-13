import {isIP} from "net";
import EventBus from "@invilite/eventbus";
import {nanoid} from "nanoid";
import {Env} from "../../../../utils/Env";
import {HrTimer} from "../../../../utils/HrTimer";
import {Express, NextFunction, Request, Response} from "express";
import {IncomingMessage} from "http";
import {ExtendedRequest} from "../../../../models/ExtendedRequest";
import HttpRequestReceivedEvent from "../../../../types/interfaces/HttpRequestReceivedEvent";
import HttpRequestCompletedEvent from "../../../../types/interfaces/HttpRequestCompletedEvent";

/**
 * The client address comes only from trusted sources: CF-Connecting-IP when the server is reachable solely through
 * Cloudflare, otherwise request.ip, which follows the `trust proxy` setting. Raw X-Forwarded-For is never read - the
 * client writes it, and a list or a non-address breaks the `inet` columns it ends up in.
 */
export function clientAddressOf(request: Request, trustCloudflare: boolean): string | undefined {
    const cloudflare: string | undefined = trustCloudflare ? request.header('CF-Connecting-IP')?.trim() : undefined;
    if (cloudflare && isIP(cloudflare) !== 0) {
        return cloudflare;
    }

    // With a broad `trust proxy` request.ip is whatever the client put first in X-Forwarded-For, address or not.
    const forwarded: string | undefined = request.ip;
    if (forwarded && isIP(forwarded) !== 0) {
        return forwarded;
    }

    return request.socket.remoteAddress;
}

export function upgradeClientAddressOf(application: Express, request: IncomingMessage, trustCloudflare: boolean): string | undefined {
    const expressRequest: Request = Object.create(application.request, {
        headers: {value: request.headers},
        socket: {value: request.socket},
    });
    return clientAddressOf(expressRequest, trustCloudflare);
}

export function requestUrlOf(originalUrl: string, origin: string): URL {
    try {
        const target: URL = new URL(originalUrl, origin);
        return new URL(`${target.pathname}${target.search}`, origin);
    } catch {
        return new URL(origin);
    }
}

export function CoreMiddleware(eventBus: EventBus, trustCloudflare: boolean = false) {
    return (request: Request, response: Response, next: NextFunction) => {
        const requestTimer: () => number = HrTimer.startTimer();
        const requestId: string = nanoid(12);
        const requestMethod: string = request.method.toUpperCase();
        const clientAddress: string | undefined = clientAddressOf(request, trustCloudflare);
        const origin: string = Env.requireUrl('HOST_NAME');
        const url: URL = requestUrlOf(request.originalUrl, origin);

        const requestEventPayload: HttpRequestReceivedEvent = {
            method: requestMethod,
            path: request.path,
            url,
            requestId,
            clientAddress,
            headers: request.headers,
            cookies: request.cookies,
            signedCookies: request.signedCookies,
        };

        eventBus.emit('http.request.received', requestEventPayload);

        let processingTime: number | null = null;

        response.once('prefinish', (): void => {
            processingTime = requestTimer();
        });

        response.once('error', (error: Error): void => {
            eventBus.emit('http.request.error', {
                ...requestEventPayload,
                error,
            });
        });

        response.once('close', (): void => {
            response.removeAllListeners('prefinish');
            response.removeAllListeners('error');
            const requestTime: number = requestTimer();

            const responseEventPayload: HttpRequestCompletedEvent = {
                statusCode: response.statusCode,
                statusMessage: response.statusMessage,
                requestTime,
                processingTime,
                ...requestEventPayload,
                locals: response.locals,
            };

            if (response.statusCode >= 400) {
                eventBus.emit('http.request.rejected', responseEventPayload);
            }

            eventBus.emit('http.request.completed', responseEventPayload);
        });

        Object.defineProperty(request, 'ip', {value: clientAddress, enumerable: true, configurable: true});

        const extendedRequest: ExtendedRequest = request as ExtendedRequest;
        extendedRequest.requestId = requestId;

        response.locals.requestId   = requestId;
        response.locals.currentUrl  = url.href;
        response.locals.origin      = url.origin;

        response.setHeader('X-Request-Id', requestId);

        next();
    }
}