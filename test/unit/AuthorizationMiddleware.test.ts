import {AuthorizationMiddleware} from "../../src/infrastructure/Server/http/middleware/AuthorizationMiddleware";
import {AuthService} from "../../src/services/AuthService";
import {ExtendedRequest} from "../../src/models/ExtendedRequest";
import {Response} from "express";
import {SessionCookies} from "../../src/services/Session/SessionCookies";
import {DEFAULT_SESSION_CONFIG} from "../../src/services/Session/SessionTypes";

const ISSUER: string = 'https://example.com';
const MCP_AUDIENCE: string = 'https://example.com/mcp';

function createAuthService(): AuthService {
    // Symmetric key: secretKey and publicKey are the same for HS256
    return new AuthService('HS256', 'unit-test-secret', 'unit-test-secret', ISSUER);
}

function createExpressLikeRequest(token?: string): any {
    return {
        headers: token ? {authorization: `Bearer ${token}`} : {},
        query: {},
        originalUrl: '/u/alice',
        signedCookies: {},
    };
}

function createUpgradeLikeRequest(token?: string): any {
    // Raw http.IncomingMessage from a WebSocket upgrade: no query property at all.
    // signedCookies is present because cookieParser runs before AuthorizationMiddleware
    // in the upgrade pipeline.
    return {
        headers: token ? {authorization: `Bearer ${token}`} : {},
        signedCookies: {},
    };
}

function createExpressLikeResponse(): any {
    return {
        locals: {},
        redirect: jest.fn(),
        setHeader: jest.fn(),
        getHeader: jest.fn().mockReturnValue(undefined),
    };
}

function createUpgradeLikeResponse(): any {
    // Fake response built by the WebSocket middleware adapter: no redirect()
    return {
        locals: {},
        setHeader: jest.fn(),
    };
}

describe('AuthorizationMiddleware', () => {
    let authService: AuthService;

    beforeEach((): void => {
        authService = createAuthService();
    });

    it('no token -> next() synchronously, no auth', async (): Promise<void> => {
        const middleware = AuthorizationMiddleware(authService);
        const request = createExpressLikeRequest();
        const response = createExpressLikeResponse();
        const next = jest.fn();

        await middleware(request, response, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(request.auth).toBeUndefined();
        expect(response.redirect).not.toHaveBeenCalled();
    });

    it('valid token -> auth set and next() called after await (race regression)', async (): Promise<void> => {
        const token: string = await authService.createToken({metadata: {username: 'alice', userId: 1}}, '1', 3600);
        const middleware = AuthorizationMiddleware(authService);
        const request = createExpressLikeRequest(token);
        const response = createExpressLikeResponse();
        const next = jest.fn();

        await middleware(request, response, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(request.auth).toBeDefined();
        expect(request.auth?.metadata?.username).toBe('alice');
        expect(response.locals.username).toBe('alice');
        expect(response.locals.userId).toBe(1);
    });

    it('the middleware leaves request.auth undefined and logs no warning for a Bearer token with a foreign audience', async (): Promise<void> => {
        const token: string = await authService.createToken({metadata: {username: 'alice', userId: 1}}, '1', 3600, [MCP_AUDIENCE]);
        const middleware = AuthorizationMiddleware(authService);
        const request: any = createExpressLikeRequest(token);
        request.logger = {debug: jest.fn(), warning: jest.fn(), error: jest.fn()};
        const response = createExpressLikeResponse();
        const next = jest.fn();

        await middleware(request, response, next);

        expect(request.auth).toBeUndefined();
        expect(request.logger.warning).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('the middleware still authenticates a Bearer web token as before', async (): Promise<void> => {
        const token: string = await authService.createToken({metadata: {username: 'alice', userId: 1}}, '1', 3600);
        const middleware = AuthorizationMiddleware(authService);
        const request: any = createExpressLikeRequest(token);
        request.logger = {debug: jest.fn(), warning: jest.fn(), error: jest.fn()};
        const response = createExpressLikeResponse();
        const next = jest.fn();

        await middleware(request, response, next);

        expect(request.auth?.metadata?.username).toBe('alice');
        expect(request.logger.warning).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('expired token on HTTP request -> redirect to refresh endpoint', async (): Promise<void> => {
        // clockTolerance in verifyToken is 30s, so the token must be expired by more than that
        const token: string = await authService.createToken({metadata: {username: 'alice', userId: 1}}, '1', -60);
        const middleware = AuthorizationMiddleware(authService);
        const request = createExpressLikeRequest(token);
        const response = createExpressLikeResponse();
        const next = jest.fn();

        await middleware(request, response, next);

        expect(response.redirect).toHaveBeenCalledTimes(1);
        expect(response.redirect).toHaveBeenCalledWith(`/user/get-token?redirect=${encodeURIComponent('/u/alice')}`);
        // Przekierowanie niesie per-user parametr `redirect` — żaden cache nie może go zapamiętać.
        expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
        expect(next).not.toHaveBeenCalled();
    });

    it('expired token on WebSocket upgrade -> next(), no throw (production crash regression)', async (): Promise<void> => {
        // clockTolerance in verifyToken is 30s, so the token must be expired by more than that
        const token: string = await authService.createToken({metadata: {username: 'alice', userId: 1}}, '1', -60);
        const middleware = AuthorizationMiddleware(authService);
        const request = createUpgradeLikeRequest(token);
        const response = createUpgradeLikeResponse();
        const next = jest.fn();

        await expect(middleware(request, response, next)).resolves.toBeUndefined();

        expect(next).toHaveBeenCalledTimes(1);
        expect(request.auth).toBeUndefined();
        expect(response.setHeader).not.toHaveBeenCalled();
    });

    it('invalid token (bad signature) -> next() without redirect', async (): Promise<void> => {
        const otherAuthService = new AuthService('HS256', 'other-secret', 'other-secret', ISSUER);
        const token: string = await otherAuthService.createToken({metadata: {username: 'intruder'}}, '2', 3600);
        const middleware = AuthorizationMiddleware(authService);
        const request = createExpressLikeRequest(token);
        const response = createExpressLikeResponse();
        const next = jest.fn();

        await middleware(request, response, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(request.auth).toBeUndefined();
        expect(response.redirect).not.toHaveBeenCalled();
    });
});
describe('AuthorizationMiddleware with SessionService (refresh in the same request)', () => {
    let authService: AuthService;
    let session: {cookies: SessionCookies; refresh: jest.Mock};

    const REFRESHED: any = {metadata: {username: 'alice', userId: 1}, role: 'user', locale: 'pl-PL', iat: 1};

    beforeEach((): void => {
        authService = createAuthService();
        session = {
            cookies: new SessionCookies(DEFAULT_SESSION_CONFIG),
            refresh: jest.fn().mockResolvedValue(REFRESHED),
        };
    });

    function cookieRequest(accessToken?: string, refreshToken: string | undefined = 'refresh'): any {
        const request: any = createExpressLikeRequest();
        request.signedCookies = {
            ...(accessToken ? {accessToken} : {}),
            ...(refreshToken ? {refreshToken} : {}),
        };
        return request;
    }

    function cookieResponse(): any {
        return {...createExpressLikeResponse(), cookie: jest.fn()};
    }

    it('regression: access cookie gone (expired with the token) + refresh cookie -> logged in, no redirect', async (): Promise<void> => {
        const middleware = AuthorizationMiddleware(authService, undefined, session as any);
        const request: any = cookieRequest();
        const response: any = cookieResponse();
        const next = jest.fn();

        await middleware(request, response, next);

        expect(session.refresh).toHaveBeenCalledTimes(1);
        expect(request.auth).toBe(REFRESHED);
        expect(response.locals.username).toBe('alice');
        expect(response.locals.userId).toBe(1);
        expect(response.redirect).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('expired access cookie + refresh cookie -> refreshed, no redirect', async (): Promise<void> => {
        const expired: string = await authService.createToken({metadata: {username: 'alice', userId: 1}}, '1', -60);
        const middleware = AuthorizationMiddleware(authService, undefined, session as any);
        const request: any = cookieRequest(expired);
        const response: any = cookieResponse();
        const next = jest.fn();

        await middleware(request, response, next);

        expect(session.refresh).toHaveBeenCalledTimes(1);
        expect(request.auth).toBe(REFRESHED);
        expect(response.redirect).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('valid access cookie -> no refresh', async (): Promise<void> => {
        const token: string = await authService.createToken({metadata: {username: 'alice', userId: 1}}, '1', 3600);
        const middleware = AuthorizationMiddleware(authService, undefined, session as any);
        const request: any = cookieRequest(token);

        await middleware(request, cookieResponse(), jest.fn());

        expect(session.refresh).not.toHaveBeenCalled();
        expect(request.auth?.metadata?.username).toBe('alice');
    });

    it('revoked access token (blacklist) -> refresh decides', async (): Promise<void> => {
        const token: string = await authService.createToken({metadata: {username: 'alice', userId: 1}}, '1', 3600);
        const blacklist: any = {isRevoked: jest.fn().mockReturnValue(true)};
        session.refresh.mockResolvedValue(null);
        const middleware = AuthorizationMiddleware(authService, blacklist, session as any);
        const request: any = cookieRequest(token);
        const next = jest.fn();

        await middleware(request, cookieResponse(), next);

        expect(session.refresh).toHaveBeenCalledTimes(1);
        expect(request.auth).toBeUndefined();
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('refresh refused -> anonymous, next() once', async (): Promise<void> => {
        session.refresh.mockResolvedValue(null);
        const middleware = AuthorizationMiddleware(authService, undefined, session as any);
        const request: any = cookieRequest();
        const response: any = cookieResponse();
        const next = jest.fn();

        await middleware(request, response, next);

        expect(request.auth).toBeUndefined();
        expect(response.locals.username).toBeUndefined();
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('refresh throws -> anonymous, error logged, next() once', async (): Promise<void> => {
        session.refresh.mockRejectedValue(new Error('boom'));
        const middleware = AuthorizationMiddleware(authService, undefined, session as any);
        const request: any = cookieRequest();
        request.logger = {debug: jest.fn(), warning: jest.fn(), error: jest.fn()};
        const next = jest.fn();

        await middleware(request, cookieResponse(), next);

        expect(request.auth).toBeUndefined();
        expect(request.logger.error).toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('expired Bearer token -> no refresh (the client manages its own tokens)', async (): Promise<void> => {
        const expired: string = await authService.createToken({metadata: {username: 'alice', userId: 1}}, '1', -60);
        const middleware = AuthorizationMiddleware(authService, undefined, session as any);
        const request: any = cookieRequest();
        request.headers = {authorization: `Bearer ${expired}`};

        await middleware(request, cookieResponse(), jest.fn());

        expect(session.refresh).not.toHaveBeenCalled();
        expect(request.auth).toBeUndefined();
    });

    it('WebSocket upgrade (response without cookie()) -> no refresh, no throw', async (): Promise<void> => {
        const middleware = AuthorizationMiddleware(authService, undefined, session as any);
        const request: any = createUpgradeLikeRequest();
        request.signedCookies = {refreshToken: 'refresh'};
        const next = jest.fn();

        await expect(middleware(request, createUpgradeLikeResponse(), next)).resolves.toBeUndefined();

        expect(session.refresh).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
    });
});
