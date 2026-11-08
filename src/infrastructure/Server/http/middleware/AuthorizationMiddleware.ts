import {NextFunction, Request, Response} from "express";
import {JsonWebTokenError, Jwt, JwtPayload, TokenExpiredError} from "jsonwebtoken";
import {AuthService} from "../../../../services/AuthService";
import {ExtendedRequest} from "../../../../models/ExtendedRequest";
import TokenBlacklistService from "../../../../services/TokenBlacklistService";
import {SessionService} from "../../../../services/Session/SessionService";
import {SessionCookies} from "../../../../services/Session/SessionCookies";

/**
 * Authorizes the request from the access token (Bearer header or signed cookie). With a SessionService, a missing,
 * expired, invalid or revoked cookie token is refreshed from the refresh cookie within the same request - the page
 * renders for the logged-in user at once, without a redirect. Without one, the legacy redirect to
 * `/user/get-token` stays (deprecated: it assumes an application route and only fires while the cookie still exists).
 */
export function AuthorizationMiddleware(authService: AuthService, tokenBlacklist?: TokenBlacklistService, session?: SessionService) {
    return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
        (request as ExtendedRequest).authService = authService;
        const extendedRequest: ExtendedRequest = request as ExtendedRequest;

        let accessToken: string | undefined;
        let fromHeader: boolean = false;

        const authHeader: string | undefined = request.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            accessToken = authHeader.substring('Bearer '.length);
            fromHeader = true;
        }

        if (!accessToken) {
            accessToken = session ? session.cookies.readAccess(request) : request.signedCookies?.accessToken || undefined;
        }

        // The returned promise lets callers that await this middleware (the WebSocket
        // upgrade adapter) wait for auth to be settled; Express ignores it and only
        // relies on next().
        let payload: JwtPayload | null = null;
        if (accessToken) {
            try {
                const jwt: Jwt = await authService.verifyToken(accessToken);
                payload = jwt.payload as JwtPayload;
            } catch (e: unknown) {
                // A token minted for another resource is anonymous here; only an audience mismatch is silenced.
                const foreignAudience: boolean = e instanceof JsonWebTokenError && e.message.startsWith('jwt audience invalid');
                if (e instanceof TokenExpiredError) {
                    extendedRequest.logger?.debug('Access token expired.');
                } else if (!foreignAudience) {
                    extendedRequest.logger?.warning('Authorization error:', (e as {message?: string} | null)?.message || e);
                }

                // Token is valid but expired: redirect to the refresh endpoint. Only HTTP
                // requests can follow a redirect - WebSocket upgrades carry a raw
                // IncomingMessage (no request.query) and a response without redirect().
                if (!session && e instanceof TokenExpiredError && typeof response.redirect === 'function' && !request.query?.redirect) {
                    // Przekierowanie niesie osobisty parametr `redirect` — żadnemu cache (zwłaszcza współdzielonemu CDN) nie wolno go zapamiętać.
                    response.setHeader('Cache-Control', 'private, no-store');
                    return response.redirect(`/user/get-token?redirect=${encodeURIComponent(request.originalUrl)}`);
                }
            }
        }

        const userId: number | undefined = payload?.metadata?.userId;
        if (payload && tokenBlacklist && typeof userId === 'number' && tokenBlacklist.isRevoked(userId, payload.iat ?? 0)) {
            extendedRequest.logger?.debug(`Request carries a revoked token for user "${userId}" - treated as anonymous.`);
            payload = null;
        }

        // A Bearer client manages its own tokens; a WebSocket upgrade cannot receive a cookie.
        if (!payload && session && !fromHeader && SessionCookies.canWrite(response)) {
            try {
                payload = await session.refresh(request, response);
            } catch (e: unknown) {
                extendedRequest.logger?.error('Session refresh error:', (e as {message?: string} | null)?.message || e);
                payload = null;
            }
        }

        if (payload) {
            applyAuth(extendedRequest, response, payload);
        }

        next();
    }
}

function applyAuth(request: ExtendedRequest, response: Response, payload: JwtPayload): void {
    request.auth = payload;

    response.locals.username = payload.metadata?.username;
    response.locals.userId = payload.metadata?.userId;
    response.locals.role = payload.role ?? null;
    response.locals.locale = payload.locale;
    response.locals.account = payload.metadata ?? null;
}
