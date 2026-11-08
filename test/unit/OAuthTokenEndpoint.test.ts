import {createHash} from 'node:crypto';
import {ClientMetadataFetcher, ClientMetadataRequest, ClientMetadataResponse, ResolvedAddress} from '../../src/services/OAuth/ClientMetadataFetcher';
import {OAuthAuthorizationServer} from '../../src/services/OAuth/OAuthAuthorizationServer';
import {
    AuthorizationRequest,
    NewOAuthAuthorizationCode,
    NewOAuthGrant,
    NewOAuthRefreshToken,
    OAuthAccessTokenClaims,
    OAuthAuthorizationCode,
    OAuthClient,
    OAuthClientStore,
    OAuthCodeStore,
    OAuthError,
    OAuthGrant,
    OAuthGrantStore,
    OAuthRefreshToken,
    OAuthRefreshTokenStore,
    OAuthServerConfig,
    OAuthStores,
    OAuthUserIdentity,
    TokenResponse,
} from '../../src/services/OAuth/OAuthTypes';

const RESOURCE: string = 'https://auth.example/mcp';
const REDIRECT_URI: string = 'https://client.example/callback';
const CLIENT_ID: string = 'registered-client';
const VERIFIER: string = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE: string = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const CONFIG: OAuthServerConfig = {
    issuer: 'https://auth.example',
    resource: RESOURCE,
    scopesSupported: ['read', 'messages', 'write'],
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
    codeTtlSeconds: 300,
    endpoints: {
        authorization: 'https://auth.example/oauth/authorize',
        token: 'https://auth.example/oauth/token',
        registration: 'https://auth.example/oauth/register',
        revocation: 'https://auth.example/oauth/revoke',
    },
};

const REGISTERED_CLIENT: OAuthClient = {
    clientId: CLIENT_ID,
    clientName: 'Registered client',
    redirectUris: [REDIRECT_URI],
    source: 'registered',
};

const AUTHORIZATION_REQUEST: AuthorizationRequest = {
    clientId: CLIENT_ID,
    clientName: REGISTERED_CLIENT.clientName,
    redirectUri: REDIRECT_URI,
    state: 'state-value',
    scope: ['read', 'messages'],
    resource: RESOURCE,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
};

function tokenResponse(result: TokenResponse | OAuthError): TokenResponse {
    if ('error' in result) {
        throw new Error(`Unexpected OAuth error: ${result.error} (${result.errorDescription})`);
    }

    return result;
}

function oauthFailure(result: TokenResponse | OAuthError): OAuthError {
    if (!('error' in result)) {
        throw new Error('Expected the token request to be rejected');
    }

    return result;
}

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

class MemoryClientStore implements OAuthClientStore {
    public readonly clients: Map<string, OAuthClient> = new Map();

    public async find(clientId: string): Promise<OAuthClient | null> {
        return this.clients.get(clientId) ?? null;
    }

    public async save(client: OAuthClient): Promise<void> {
        this.clients.set(client.clientId, client);
    }
}

class MemoryCodeStore implements OAuthCodeStore {
    public readonly codes: Map<string, OAuthAuthorizationCode> = new Map();

    public async save(code: NewOAuthAuthorizationCode): Promise<void> {
        this.codes.set(code.codeHash, {...code, usedAt: null});
    }

    public async find(codeHash: string): Promise<OAuthAuthorizationCode | null> {
        return this.codes.get(codeHash) ?? null;
    }

    public async consume(codeHash: string): Promise<OAuthAuthorizationCode | null> {
        const code: OAuthAuthorizationCode | undefined = this.codes.get(codeHash);
        if (!code || code.usedAt !== null) {
            return null;
        }

        code.usedAt = new Date();

        return code;
    }
}

class MemoryGrantStore implements OAuthGrantStore {
    public readonly grants: Map<number, OAuthGrant> = new Map();
    private nextId: number = 1;

    public async createOrRenew(grant: NewOAuthGrant): Promise<OAuthGrant> {
        for (const existing of this.grants.values()) {
            if (existing.userId === grant.userId && existing.clientId === grant.clientId && existing.revokedAt === null) {
                existing.scope = [...grant.scope];
                existing.lastUsedAt = new Date();

                return existing;
            }
        }

        const created: OAuthGrant = {
            id: this.nextId,
            userId: grant.userId,
            clientId: grant.clientId,
            scope: [...grant.scope],
            createdAt: new Date(),
            lastUsedAt: null,
            revokedAt: null,
        };
        this.nextId += 1;
        this.grants.set(created.id, created);

        return created;
    }

    public async findById(grantId: number): Promise<OAuthGrant | null> {
        return this.grants.get(grantId) ?? null;
    }

    public async revoke(grantId: number): Promise<void> {
        const grant: OAuthGrant | undefined = this.grants.get(grantId);
        if (grant) {
            grant.revokedAt = new Date();
        }
    }

    public async revokeAllForUsers(userIds: number[]): Promise<void> {
        for (const grant of this.grants.values()) {
            if (userIds.includes(grant.userId)) {
                grant.revokedAt = new Date();
            }
        }
    }
}

class MemoryRefreshTokenStore implements OAuthRefreshTokenStore {
    public readonly tokens: Map<string, OAuthRefreshToken> = new Map();

    public constructor(private readonly grantOwner: (grantId: number) => number | undefined) {
    }

    public async save(token: NewOAuthRefreshToken): Promise<void> {
        this.tokens.set(token.tokenHash, {...token, usedAt: null, revokedAt: null});
    }

    public async find(tokenHash: string): Promise<OAuthRefreshToken | null> {
        return this.tokens.get(tokenHash) ?? null;
    }

    public async rotate(currentTokenHash: string, next: NewOAuthRefreshToken): Promise<boolean> {
        const current: OAuthRefreshToken | undefined = this.tokens.get(currentTokenHash);
        if (!current || current.usedAt !== null || current.revokedAt !== null || current.expiresAt.getTime() <= Date.now()) {
            return false;
        }

        current.usedAt = new Date();
        this.tokens.set(next.tokenHash, {...next, usedAt: null, revokedAt: null});

        return true;
    }

    public async revokeAllForGrant(grantId: number): Promise<void> {
        for (const token of this.tokens.values()) {
            if (token.grantId === grantId) {
                token.revokedAt = new Date();
            }
        }
    }

    public async revokeAllForUsers(userIds: number[]): Promise<void> {
        for (const token of this.tokens.values()) {
            const owner: number | undefined = this.grantOwner(token.grantId);
            if (owner !== undefined && userIds.includes(owner)) {
                token.revokedAt = new Date();
            }
        }
    }
}

class MutableIdentity implements OAuthUserIdentity {
    public active: boolean = true;

    public async isActive(): Promise<boolean> {
        return this.active;
    }
}

function metadataFetcher(): ClientMetadataFetcher {
    return new ClientMetadataFetcher({
        resolver: async (): Promise<ResolvedAddress[]> => [{address: '93.184.216.34', family: 4}],
        transport: async (request: ClientMetadataRequest): Promise<ClientMetadataResponse> => ({
            statusCode: 200,
            body: JSON.stringify({
                client_id: request.url,
                client_name: 'Metadata client',
                redirect_uris: [REDIRECT_URI],
            }),
        }),
    });
}

interface Fixture {
    server: OAuthAuthorizationServer;
    clients: MemoryClientStore;
    codes: MemoryCodeStore;
    grants: MemoryGrantStore;
    refreshTokens: MemoryRefreshTokenStore;
    identity: MutableIdentity;
    signer: jest.Mock<Promise<string>, [OAuthAccessTokenClaims, number, string[]]>;
}

async function build(userIds: number[] = [7]): Promise<Fixture> {
    const clients: MemoryClientStore = new MemoryClientStore();
    clients.clients.set(REGISTERED_CLIENT.clientId, REGISTERED_CLIENT);
    const codes: MemoryCodeStore = new MemoryCodeStore();
    const grants: MemoryGrantStore = new MemoryGrantStore();
    const refreshTokens: MemoryRefreshTokenStore = new MemoryRefreshTokenStore(
        (grantId: number): number | undefined => grants.grants.get(grantId)?.userId,
    );
    const identity: MutableIdentity = new MutableIdentity();
    const signer: jest.Mock<Promise<string>, [OAuthAccessTokenClaims, number, string[]]> = jest.fn(
        async (claims: OAuthAccessTokenClaims, ttl: number, audience: string[]): Promise<string> =>
            `access-${claims.grant_id}-${ttl}-${audience.join(',')}`,
    );
    const stores: OAuthStores = {clients, codes, grants, refreshTokens};
    for (const userId of userIds) {
        await grants.createOrRenew({userId, clientId: CLIENT_ID, scope: ['read', 'messages']});
    }

    return {
        server: new OAuthAuthorizationServer(CONFIG, stores, metadataFetcher(), signer, identity),
        clients,
        codes,
        grants,
        refreshTokens,
        identity,
        signer,
    };
}

async function issueCode(fixture: Fixture, userId: number = 7, scope: string[] = ['read', 'messages']): Promise<string> {
    const result: {redirectTo: string} = await fixture.server.issueCode(
        {userId, clientId: CLIENT_ID, scope},
        {...AUTHORIZATION_REQUEST, scope},
    );
    const code: string | null = new URL(result.redirectTo).searchParams.get('code');
    if (code === null) {
        throw new Error('issueCode did not return a code');
    }

    return code;
}

function codeRequest(code: string, overrides: Record<string, string> = {}): Record<string, string> {
    return {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        code_verifier: VERIFIER,
        ...overrides,
    };
}

describe('OAuthAuthorizationServer token endpoint', () => {
    it('exchange rejects a reused authorization code and a wrong code_verifier', async () => {
        const fixture: Fixture = await build();
        const code: string = await issueCode(fixture);

        const wrongVerifier: OAuthError = oauthFailure(await fixture.server.exchange(codeRequest(code, {
            code_verifier: 'x'.repeat(43),
        })));
        expect(wrongVerifier.error).toBe('invalid_grant');
        expect(fixture.grants.grants.get(1)?.revokedAt).toBeNull();

        tokenResponse(await fixture.server.exchange(codeRequest(code)));

        const reused: OAuthError = oauthFailure(await fixture.server.exchange(codeRequest(code)));
        expect(reused.error).toBe('invalid_grant');
        expect(fixture.grants.grants.get(1)?.revokedAt).not.toBeNull();
    });

    it('exchange issues an access token with aud equal to the resource and a rotated refresh token', async () => {
        const fixture: Fixture = await build();
        const code: string = await issueCode(fixture);

        const first: TokenResponse = tokenResponse(await fixture.server.exchange(codeRequest(code)));
        expect(first.token_type).toBe('Bearer');
        expect(first.expires_in).toBe(CONFIG.accessTokenTtlSeconds);
        expect(first.scope).toBe('read messages');
        expect(fixture.signer).toHaveBeenCalledWith(
            {sub: 7, client_id: CLIENT_ID, grant_id: 1, scope: 'read messages'},
            CONFIG.accessTokenTtlSeconds,
            [RESOURCE],
        );

        const second: TokenResponse = tokenResponse(await fixture.server.exchange({
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: CLIENT_ID,
            resource: RESOURCE,
        }));
        expect(second.refresh_token).not.toBe(first.refresh_token);
        expect(fixture.refreshTokens.tokens.get(hash(first.refresh_token))?.usedAt).not.toBeNull();
        expect(fixture.refreshTokens.tokens.get(hash(second.refresh_token))?.usedAt).toBeNull();
    });

    it('reusing an already rotated refresh token revokes the whole grant', async () => {
        const fixture: Fixture = await build();
        const code: string = await issueCode(fixture);
        const first: TokenResponse = tokenResponse(await fixture.server.exchange(codeRequest(code)));
        const second: TokenResponse = tokenResponse(await fixture.server.exchange({
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: CLIENT_ID,
            resource: RESOURCE,
        }));

        const reused: OAuthError = oauthFailure(await fixture.server.exchange({
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: CLIENT_ID,
            resource: RESOURCE,
        }));
        expect(reused.error).toBe('invalid_grant');
        expect(fixture.grants.grants.get(1)?.revokedAt).not.toBeNull();
        expect(fixture.refreshTokens.tokens.get(hash(second.refresh_token))?.revokedAt).not.toBeNull();
    });

    it('refresh fails with invalid_grant when isActive returns false', async () => {
        const fixture: Fixture = await build();
        const code: string = await issueCode(fixture);
        const first: TokenResponse = tokenResponse(await fixture.server.exchange(codeRequest(code)));

        fixture.identity.active = false;
        const inactive: OAuthError = oauthFailure(await fixture.server.exchange({
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: CLIENT_ID,
            resource: RESOURCE,
        }));
        expect(inactive.error).toBe('invalid_grant');
        expect(fixture.refreshTokens.tokens.get(hash(first.refresh_token))?.usedAt).toBeNull();

        fixture.identity.active = true;
        tokenResponse(await fixture.server.exchange({
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: CLIENT_ID,
            resource: RESOURCE,
        }));
    });

    it('revokeUserGrants revokes grants and refresh tokens of the given users', async () => {
        const fixture: Fixture = await build([7, 8]);
        const code: string = await issueCode(fixture);
        const token: TokenResponse = tokenResponse(await fixture.server.exchange(codeRequest(code)));
        const otherCode: string = await issueCode(fixture, 8);
        const otherToken: TokenResponse = tokenResponse(await fixture.server.exchange(codeRequest(otherCode)));

        await fixture.server.revokeUserGrants([7]);

        expect(fixture.grants.grants.get(1)?.revokedAt).not.toBeNull();
        expect(fixture.grants.grants.get(2)?.revokedAt).toBeNull();
        expect(fixture.refreshTokens.tokens.get(hash(token.refresh_token))?.revokedAt).not.toBeNull();
        expect(fixture.refreshTokens.tokens.get(hash(otherToken.refresh_token))?.revokedAt).toBeNull();
    });

    it('issueCode upserts the metadata client and builds redirectTo with code, state and iss', async () => {
        const fixture: Fixture = await build();
        const metadataClientId: string = 'https://client.example/client.json';
        const state: string = 'a b&c';
        const result: {redirectTo: string} = await fixture.server.issueCode(
            {userId: 7, clientId: metadataClientId, scope: ['read']},
            {...AUTHORIZATION_REQUEST, clientId: metadataClientId, clientName: 'Metadata client', state, scope: ['read']},
        );

        const redirect: URL = new URL(result.redirectTo);
        expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
        expect(redirect.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(redirect.searchParams.get('state')).toBe(state);
        expect(redirect.searchParams.get('iss')).toBe(CONFIG.issuer);
        expect(fixture.clients.clients.get(metadataClientId)).toEqual({
            clientId: metadataClientId,
            clientName: 'Metadata client',
            redirectUris: [REDIRECT_URI],
            source: 'metadata_document',
        });
        expect(fixture.codes.codes.get(hash(redirect.searchParams.get('code') as string))?.codeChallenge).toBe(CHALLENGE);
    });

    it('issueCode persists the client before the grant so the grant foreign key is satisfied', async () => {
        const fixture: Fixture = await build();
        const calls: string[] = [];
        const saveClient = fixture.clients.save.bind(fixture.clients);
        const createOrRenew = fixture.grants.createOrRenew.bind(fixture.grants);
        jest.spyOn(fixture.clients, 'save').mockImplementation(async (client: OAuthClient): Promise<void> => {
            calls.push('client');
            await saveClient(client);
        });
        jest.spyOn(fixture.grants, 'createOrRenew').mockImplementation(async (grant: NewOAuthGrant): Promise<OAuthGrant> => {
            calls.push('grant');

            return await createOrRenew(grant);
        });

        await issueCode(fixture);

        expect(calls).toEqual(['client', 'grant']);
    });

    it('exchange rejects a code presented by another client, a wrong redirect_uri and a foreign resource', async () => {
        const fixture: Fixture = await build();
        const code: string = await issueCode(fixture);
        await fixture.clients.save({...REGISTERED_CLIENT, clientId: 'other-client'});

        const wrongClient: OAuthError = oauthFailure(await fixture.server.exchange(codeRequest(code, {client_id: 'other-client'})));
        expect(wrongClient.error).toBe('invalid_grant');

        const wrongRedirect: OAuthError = oauthFailure(await fixture.server.exchange(codeRequest(code, {
            redirect_uri: 'https://client.example/other',
        })));
        expect(wrongRedirect.error).toBe('invalid_grant');

        const foreignResource: OAuthError = oauthFailure(await fixture.server.exchange(codeRequest(code, {
            resource: 'https://other.example/mcp',
        })));
        expect(foreignResource.error).toBe('invalid_request');

        const unknownGrant: OAuthError = oauthFailure(await fixture.server.exchange(codeRequest('unknown-code')));
        expect(unknownGrant.error).toBe('invalid_grant');
    });

    it('exchange rejects an unsupported grant type and a missing client_id', async () => {
        const fixture: Fixture = await build();

        const unsupported: OAuthError = oauthFailure(await fixture.server.exchange({grant_type: 'client_credentials'}));
        expect(unsupported.error).toBe('unsupported_grant_type');

        const missingClient: OAuthError = oauthFailure(await fixture.server.exchange({
            grant_type: 'authorization_code',
            code: 'code',
        }));
        expect(missingClient.error).toBe('invalid_request');

        const missingType: OAuthError = oauthFailure(await fixture.server.exchange({}));
        expect(missingType.error).toBe('invalid_request');
    });

    it('revoke revokes the grant behind a refresh token only for its own client', async () => {
        const fixture: Fixture = await build();
        const code: string = await issueCode(fixture);
        const token: TokenResponse = tokenResponse(await fixture.server.exchange(codeRequest(code)));

        await fixture.server.revoke({
            token: token.refresh_token,
            client_id: 'other-client',
            token_type_hint: 'refresh_token',
        });
        expect(fixture.grants.grants.get(1)?.revokedAt).toBeNull();

        await fixture.server.revoke({token: token.refresh_token, client_id: CLIENT_ID});
        expect(fixture.grants.grants.get(1)?.revokedAt).not.toBeNull();
        expect(fixture.refreshTokens.tokens.get(hash(token.refresh_token))?.revokedAt).not.toBeNull();
    });
});
