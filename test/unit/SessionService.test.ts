import {AuthService} from "../../src/services/AuthService";
import {SessionService} from "../../src/services/Session/SessionService";
import {
    DEFAULT_SESSION_CONFIG,
    NewRefreshToken,
    RefreshTokenRecord,
    RefreshTokenStore,
    SessionIdentity,
    SessionIdentityProvider,
} from "../../src/services/Session/SessionTypes";

const ISSUER: string = 'https://example.com';
const REFRESH_TOKEN: string = 'refresh-token-value';

const loggerStub: any = {
    trace: jest.fn(), debug: jest.fn(), info: jest.fn(), notice: jest.fn(), warning: jest.fn(),
    error: jest.fn(), critical: jest.fn(), alert: jest.fn(), emergency: jest.fn(),
};

class MemoryStore implements RefreshTokenStore {
    public readonly records: Map<string, RefreshTokenRecord> = new Map();
    public readonly inserted: NewRefreshToken[] = [];
    public readonly touched: string[] = [];

    public async find(tokenHash: string): Promise<RefreshTokenRecord | null> {
        return this.records.get(tokenHash) ?? null;
    }

    public async insert(token: NewRefreshToken): Promise<void> {
        this.inserted.push(token);
        this.records.set(token.tokenHash, {userId: token.userId, tokenHash: token.tokenHash, expiresAt: token.expiresAt, revokedAt: null});
    }

    public async touch(tokenHash: string): Promise<void> {
        this.touched.push(tokenHash);
    }

    public async revoke(tokenHash: string): Promise<void> {
        const record: RefreshTokenRecord | undefined = this.records.get(tokenHash);
        if (record) {
            record.revokedAt = new Date();
        }
    }

    public async revokeAllForUser(userId: number): Promise<void> {
        for (const record of this.records.values()) {
            if (record.userId === userId) {
                record.revokedAt = new Date();
            }
        }
    }
}

function identityOf(identity: SessionIdentity | null): SessionIdentityProvider & {identify: jest.Mock} {
    return {identify: jest.fn().mockResolvedValue(identity)};
}

const ALICE: SessionIdentity = {subject: 'alice', role: 'user', locale: 'pl-PL', metadata: {avatarUrl: '/a.jpg'}};

function createRequest(refreshToken?: string): any {
    return {
        headers: {'user-agent': 'jest'},
        signedCookies: refreshToken ? {refreshToken} : {},
        ip: '127.0.0.1',
    };
}

function createResponse(): any {
    return {cookie: jest.fn()};
}

function cookieCall(response: any, name: string): any[] | undefined {
    return response.cookie.mock.calls.find((call: any[]): boolean => call[0] === name);
}

describe('SessionService', () => {
    let authService: AuthService;
    let store: MemoryStore;

    beforeEach((): void => {
        jest.clearAllMocks();
        authService = new AuthService('HS256', 'unit-test-secret', 'unit-test-secret', ISSUER);
        store = new MemoryStore();
    });

    function createSession(identity: SessionIdentityProvider, blacklist: any = null): SessionService {
        return new SessionService(authService, store, identity, blacklist, DEFAULT_SESSION_CONFIG, loggerStub);
    }

    function storeValidToken(userId: number = 7): void {
        const tokenHash: string = authService.calculateTokenHash(REFRESH_TOKEN);
        store.records.set(tokenHash, {userId, tokenHash, expiresAt: new Date(Date.now() + 60_000), revokedAt: null});
    }

    describe('refresh', () => {
        it('valid refresh token -> verified payload, access cookie set, token touched', async (): Promise<void> => {
            storeValidToken();
            const session: SessionService = createSession(identityOf(ALICE));
            const response: any = createResponse();

            const payload = await session.refresh(createRequest(REFRESH_TOKEN), response);

            expect(payload?.metadata).toEqual({avatarUrl: '/a.jpg', userId: 7, username: 'alice'});
            expect(payload?.sub).toBe('alice');
            expect(payload?.role).toBe('user');
            expect(typeof payload?.iat).toBe('number');
            expect(cookieCall(response, 'accessToken')?.[2]).toMatchObject({maxAge: 3600 * 1000, signed: true, httpOnly: true, sameSite: 'lax'});
            expect(store.touched).toHaveLength(1);
        });

        it('identity metadata cannot override userId or username', async (): Promise<void> => {
            storeValidToken();
            const session: SessionService = createSession(identityOf({...ALICE, metadata: {userId: 1, username: 'admin'}}));

            const payload = await session.refresh(createRequest(REFRESH_TOKEN), createResponse());

            expect(payload?.metadata).toEqual({userId: 7, username: 'alice'});
        });

        it('no refresh cookie -> null, no cookie written, store not queried', async (): Promise<void> => {
            const identity = identityOf(ALICE);
            const session: SessionService = createSession(identity);
            const response: any = createResponse();
            const find = jest.spyOn(store, 'find');

            expect(await session.refresh(createRequest(), response)).toBeNull();
            expect(response.cookie).not.toHaveBeenCalled();
            expect(find).not.toHaveBeenCalled();
        });

        it.each([
            ['unknown', (): void => {}],
            ['expired', (): void => {
                const tokenHash: string = authService.calculateTokenHash(REFRESH_TOKEN);
                store.records.set(tokenHash, {userId: 7, tokenHash, expiresAt: new Date(Date.now() - 1000), revokedAt: null});
            }],
            ['revoked', (): void => {
                const tokenHash: string = authService.calculateTokenHash(REFRESH_TOKEN);
                store.records.set(tokenHash, {userId: 7, tokenHash, expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date()});
            }],
        ])('%s refresh token -> null and both session cookies cleared', async (_label: string, arrange: () => void): Promise<void> => {
            arrange();
            const session: SessionService = createSession(identityOf(ALICE));
            const response: any = createResponse();

            expect(await session.refresh(createRequest(REFRESH_TOKEN), response)).toBeNull();
            expect(cookieCall(response, 'accessToken')?.[2]).toMatchObject({maxAge: 0});
            expect(cookieCall(response, 'refreshToken')?.[2]).toMatchObject({maxAge: 0});
            expect(store.touched).toHaveLength(0);
        });

        it('identity refused (blocked account) -> null and cookies cleared', async (): Promise<void> => {
            storeValidToken();
            const session: SessionService = createSession(identityOf(null));
            const response: any = createResponse();

            expect(await session.refresh(createRequest(REFRESH_TOKEN), response)).toBeNull();
            expect(cookieCall(response, 'refreshToken')?.[2]).toMatchObject({maxAge: 0});
        });

        it('storage failure -> null, cookies kept (transient), error logged', async (): Promise<void> => {
            jest.spyOn(store, 'find').mockRejectedValue(new Error('connection refused'));
            const session: SessionService = createSession(identityOf(ALICE));
            const response: any = createResponse();

            expect(await session.refresh(createRequest(REFRESH_TOKEN), response)).toBeNull();
            expect(response.cookie).not.toHaveBeenCalled();
            expect(loggerStub.error).toHaveBeenCalled();
        });
    });

    describe('start', () => {
        it('stores the hash (never the token), sets both cookies with lifetimes from the config', async (): Promise<void> => {
            const session: SessionService = createSession(identityOf(ALICE));
            const response: any = createResponse();

            const payload = await session.start(createRequest(), response, 7);

            expect(payload?.metadata?.userId).toBe(7);
            expect(store.inserted).toHaveLength(1);
            const refreshToken: string = cookieCall(response, 'refreshToken')?.[1];
            expect(store.inserted[0].tokenHash).toBe(authService.calculateTokenHash(refreshToken));
            expect(store.inserted[0].tokenHash).not.toBe(refreshToken);
            expect(store.inserted[0]).toMatchObject({userId: 7, ipAddress: '127.0.0.1', userAgent: 'jest'});
            expect(cookieCall(response, 'refreshToken')?.[2]).toMatchObject({maxAge: 30 * 24 * 3600 * 1000});
            expect(cookieCall(response, 'accessToken')?.[2]).toMatchObject({maxAge: 3600 * 1000});
        });

        it('identity refused -> null, nothing stored, no cookie', async (): Promise<void> => {
            const session: SessionService = createSession(identityOf(null));
            const response: any = createResponse();

            expect(await session.start(createRequest(), response, 7)).toBeNull();
            expect(store.inserted).toHaveLength(0);
            expect(response.cookie).not.toHaveBeenCalled();
        });

        it('unknown client address -> throws before storing (inet NOT NULL)', async (): Promise<void> => {
            const session: SessionService = createSession(identityOf(ALICE));
            const request: any = {...createRequest(), ip: undefined};

            await expect(session.start(request, createResponse(), 7)).rejects.toThrow(/client address/);
            expect(store.inserted).toHaveLength(0);
        });
    });

    it('end -> revokes the current refresh token and clears cookies', async (): Promise<void> => {
        storeValidToken();
        const session: SessionService = createSession(identityOf(ALICE));
        const response: any = createResponse();

        await session.end(createRequest(REFRESH_TOKEN), response);

        expect(store.records.get(authService.calculateTokenHash(REFRESH_TOKEN))?.revokedAt).not.toBeNull();
        expect(cookieCall(response, 'refreshToken')?.[2]).toMatchObject({maxAge: 0});
    });

    it('endAll -> durable revocation first, then the blacklist broadcast', async (): Promise<void> => {
        const order: string[] = [];
        jest.spyOn(store, 'revokeAllForUser').mockImplementation(async (): Promise<void> => { order.push('store'); });
        const blacklist: any = {revokeAllForUser: jest.fn(async (): Promise<void> => { order.push('blacklist'); })};
        const session: SessionService = createSession(identityOf(ALICE), blacklist);

        await session.endAll(7);

        expect(order).toEqual(['store', 'blacklist']);
        expect(blacklist.revokeAllForUser).toHaveBeenCalledWith(7);
    });

    it('endAll returns the blacklist broadcast result', async (): Promise<void> => {
        const blacklist: any = {revokeAllForUser: jest.fn(async (): Promise<boolean> => false)};
        const session: SessionService = createSession(identityOf(ALICE), blacklist);

        await expect(session.endAll(7)).resolves.toBe(false);
    });

    it('endAll returns true without a blacklist', async (): Promise<void> => {
        const session: SessionService = createSession(identityOf(ALICE));

        await expect(session.endAll(7)).resolves.toBe(true);
    });
});
