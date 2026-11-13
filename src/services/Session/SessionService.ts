import {Request, Response} from "express";
import {Jwt, JwtPayload} from "jsonwebtoken";
import {AuthService} from "../AuthService";
import TokenBlacklistService from "../TokenBlacklistService";
import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {ExtendedRequest} from "../../models/ExtendedRequest";
import {SessionCookies} from "./SessionCookies";
import {RefreshTokenRecord, RefreshTokenStore, SessionConfig, SessionIdentity, SessionIdentityProvider} from "./SessionTypes";

/**
 * Session lifecycle shared by every site on this framework: login, access token refresh (also inline, from
 * AuthorizationMiddleware - the page renders for the logged-in user on the first request), re-issue, logout
 * and killing all sessions of a user. The application only says who the user is (SessionIdentityProvider);
 * it never touches the session cookies or the refresh token storage directly.
 */
export class SessionService {
    public readonly cookies: SessionCookies;

    public constructor(
        private readonly authService: AuthService,
        private readonly store: RefreshTokenStore,
        private readonly identity: SessionIdentityProvider,
        private readonly blacklist: TokenBlacklistService | null,
        private readonly config: SessionConfig,
        private readonly logger: AbstractLogger,
    ) {
        this.cookies = new SessionCookies(config);
    }

    /**
     * New session after the application verified the credentials and its own gates. `null` = the identity
     * provider refused (e.g. blocked) - no cookie is set.
     */
    public async start(request: Request, response: Response, userId: number): Promise<JwtPayload | null> {
        const identity: SessionIdentity | null = await this.identity.identify(userId);
        if (!identity) {
            return null;
        }

        const ipAddress: string | undefined = (request as ExtendedRequest).clientAddress ?? request.ip;
        if (!ipAddress) {
            // refresh_tokens.ip_address is inet NOT NULL - an empty string would fail the INSERT with a cryptic error.
            throw new Error('Cannot start a session: the client address is unknown.');
        }

        const refreshToken: string = this.authService.generateRefreshToken();
        await this.store.insert({
            userId,
            tokenHash: this.authService.calculateTokenHash(refreshToken),
            ipAddress,
            userAgent: request.headers['user-agent'] ?? '',
            expiresAt: new Date(Date.now() + this.config.refreshTtlSeconds * 1000),
        });
        this.cookies.setRefresh(response, refreshToken);

        return this.issueAccess(response, userId, identity);
    }

    /**
     * Mints an access token from the refresh cookie. A certain refusal (unknown, expired or revoked token,
     * identity refused) clears the session cookies, so later requests do not query the store again. A storage
     * failure keeps them - it is transient, the request just goes on as anonymous.
     */
    public async refresh(request: Request, response: Response): Promise<JwtPayload | null> {
        const refreshToken: string | undefined = this.cookies.readRefresh(request);
        if (!refreshToken) {
            return null;
        }

        const tokenHash: string = this.authService.calculateTokenHash(refreshToken);
        let record: RefreshTokenRecord | null;
        let identity: SessionIdentity | null = null;
        try {
            record = await this.store.find(tokenHash);
            if (record && SessionService.isUsable(record)) {
                identity = await this.identity.identify(record.userId);
            }
        } catch (e: unknown) {
            this.logger.error(`Session refresh failed: ${(e as {message?: string} | null)?.message || e}`);
            return null;
        }

        if (!record || !identity) {
            this.logger.debug('Refresh token is unknown, expired or revoked, or the account may not hold a session - session cookies cleared.');
            this.cookies.clear(response);
            return null;
        }

        await this.store.touch(tokenHash);

        return this.issueAccess(response, record.userId, identity);
    }

    /** New access token when what it carries changed (e.g. the avatar); the refresh token stays. */
    public async reissue(response: Response, userId: number): Promise<JwtPayload | null> {
        const identity: SessionIdentity | null = await this.identity.identify(userId);
        if (!identity) {
            return null;
        }

        return this.issueAccess(response, userId, identity);
    }

    public async end(request: Request, response: Response): Promise<void> {
        const refreshToken: string | undefined = this.cookies.readRefresh(request);
        if (refreshToken) {
            await this.store.revoke(this.authService.calculateTokenHash(refreshToken));
        }
        this.cookies.clear(response);
    }

    /**
     * Kills every session of the user. Order matters: the durable revocation first, then the in-memory
     * blacklist broadcast - a refresh between the two would otherwise mint a token the blacklist never sees.
     */
    public async endAll(userId: number): Promise<boolean> {
        await this.store.revokeAllForUser(userId);
        return this.blacklist ? this.blacklist.revokeAllForUser(userId) : true;
    }

    public clearCookies(response: Response): void {
        this.cookies.clear(response);
    }

    private async issueAccess(response: Response, userId: number, identity: SessionIdentity): Promise<JwtPayload> {
        const token: string = await this.authService.createToken({
            role: identity.role,
            locale: identity.locale,
            // userId and username last: the application cannot override the identity the middleware relies on.
            metadata: {...identity.metadata, userId, username: identity.subject},
        }, identity.subject, this.config.accessTtlSeconds);
        this.cookies.setAccess(response, token);

        // The same verified shape a cookie token would give (iat, exp, sub...), so the request is authorized at once.
        const jwt: Jwt = await this.authService.verifyToken(token);
        return jwt.payload as JwtPayload;
    }

    private static isUsable(record: RefreshTokenRecord): boolean {
        return record.revokedAt === null && record.expiresAt !== null && record.expiresAt.getTime() > Date.now();
    }
}
