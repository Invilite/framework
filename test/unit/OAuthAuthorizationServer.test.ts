import {AbstractLogger} from '../../src/types/interfaces/AbstractLogger';
import {
    ClientMetadataFetcher,
    ClientMetadataRequest,
    ClientMetadataResponse,
    ResolvedAddress,
} from '../../src/services/OAuth/ClientMetadataFetcher';
import {OAuthAuthorizationServer} from '../../src/services/OAuth/OAuthAuthorizationServer';
import {
    AuthorizationRequest,
    AuthorizationRequestResult,
    OAuthAuthorizationCode,
    OAuthClient,
    OAuthClientStore,
    OAuthCodeStore,
    OAuthError,
    OAuthGrant,
    OAuthGrantStore,
    OAuthRefreshTokenStore,
    OAuthServerConfig,
    OAuthServerMetadata,
    OAuthUserIdentity,
} from '../../src/services/OAuth/OAuthTypes';

const RESOURCE: string = 'https://auth.example/mcp';
const REDIRECT_URI: string = 'https://client.example/callback';
const METADATA_CLIENT_URL: string = 'https://client.example/client.json';
const RFC_CHALLENGE: string = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

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

const VALID_QUERY: Record<string, string> = {
    response_type: 'code',
    client_id: 'registered-client',
    redirect_uri: REDIRECT_URI,
    code_challenge: RFC_CHALLENGE,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: 'read messages',
    state: 'state-value',
};

const REGISTERED_CLIENT: OAuthClient = {
    clientId: 'registered-client',
    clientName: 'Registered client',
    redirectUris: [REDIRECT_URI],
    source: 'registered',
};

type AuthorizationFailure = Extract<AuthorizationRequestResult, {ok: false}>;

class MemoryClientStore implements OAuthClientStore {
    public readonly clients: Map<string, OAuthClient> = new Map();
    public readonly saved: OAuthClient[] = [];

    public async find(clientId: string): Promise<OAuthClient | null> {
        return this.clients.get(clientId) ?? null;
    }

    public async save(client: OAuthClient): Promise<void> {
        this.saved.push(client);
        this.clients.set(client.clientId, client);
    }
}

const codeStore: OAuthCodeStore = {
    save: async (): Promise<void> => undefined,
    find: async (): Promise<OAuthAuthorizationCode | null> => null,
    consume: async (): Promise<OAuthAuthorizationCode | null> => null,
};

const grantStore: OAuthGrantStore = {
    createOrRenew: async (): Promise<OAuthGrant> => {
        throw new Error('The grant store is not used by authorization request validation');
    },
    findById: async (): Promise<OAuthGrant | null> => null,
    revoke: async (): Promise<void> => undefined,
    revokeAllForUsers: async (): Promise<void> => undefined,
};

const refreshTokenStore: OAuthRefreshTokenStore = {
    save: async (): Promise<void> => undefined,
    find: async (): Promise<null> => null,
    rotate: async (): Promise<boolean> => false,
    revokeAllForGrant: async (): Promise<void> => undefined,
    revokeAllForUsers: async (): Promise<void> => undefined,
};

const accessTokenSigner = async (): Promise<string> => 'access-token';
const userIdentity: OAuthUserIdentity = {isActive: async (): Promise<boolean> => true};

function buildServer(
    clients: OAuthClientStore,
    fetcher: ClientMetadataFetcher,
    logger?: AbstractLogger,
): OAuthAuthorizationServer {
    return new OAuthAuthorizationServer(
        CONFIG,
        {clients, codes: codeStore, grants: grantStore, refreshTokens: refreshTokenStore},
        fetcher,
        accessTokenSigner,
        userIdentity,
        logger,
    );
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

function failingMetadataFetcher(): ClientMetadataFetcher {
    return new ClientMetadataFetcher({
        resolver: async (): Promise<ResolvedAddress[]> => [{address: '93.184.216.34', family: 4}],
        transport: async (): Promise<ClientMetadataResponse> => {
            throw new Error('metadata unavailable');
        },
    });
}

function loggerStub(): AbstractLogger & {warning: jest.Mock} {
    const warning: jest.Mock = jest.fn();

    return {
        trace: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        notice: jest.fn(),
        warning,
        error: jest.fn(),
        critical: jest.fn(),
        alert: jest.fn(),
        emergency: jest.fn(),
    };
}

function expectAuthorizationRequest(result: AuthorizationRequestResult): AuthorizationRequest {
    if (!result.ok) {
        throw new Error(`Unexpected OAuth error: ${result.error.error}`);
    }

    return result.request;
}

function expectAuthorizationFailure(result: AuthorizationRequestResult): AuthorizationFailure {
    if (result.ok) {
        throw new Error('Expected the authorization request to be rejected');
    }

    return result;
}

describe('OAuthAuthorizationServer', () => {
    let clients: MemoryClientStore;
    let server: OAuthAuthorizationServer;

    beforeEach((): void => {
        clients = new MemoryClientStore();
        clients.clients.set(REGISTERED_CLIENT.clientId, REGISTERED_CLIENT);
        server = buildServer(clients, metadataFetcher());
    });

    it('validateAuthorizationRequest rejects a missing code_challenge, a foreign resource and an unregistered redirect_uri', async () => {
        const missingChallenge: AuthorizationFailure = expectAuthorizationFailure(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            code_challenge: '',
        }));
        expect(missingChallenge.error.error).toBe('invalid_request');

        const foreignResource: AuthorizationFailure = expectAuthorizationFailure(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            resource: 'https://other.example/mcp',
        }));
        expect(foreignResource.error.error).toBe('invalid_request');

        const unregisteredRedirect: AuthorizationFailure = expectAuthorizationFailure(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            redirect_uri: 'https://attacker.example/callback',
        }));
        expect(unregisteredRedirect.error.error).toBe('invalid_request');

        const plainChallenge: AuthorizationFailure = expectAuthorizationFailure(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            code_challenge_method: 'plain',
        }));
        expect(plainChallenge.error.error).toBe('invalid_request');

        clients.clients.set('legacy-client', {
            clientId: 'legacy-client',
            clientName: 'Legacy client',
            redirectUris: ['http://client.example/callback'],
            source: 'registered',
        });
        const unsafeRegisteredRedirect: AuthorizationFailure = expectAuthorizationFailure(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            client_id: 'legacy-client',
            redirect_uri: 'http://client.example/callback',
        }));
        expect(unsafeRegisteredRedirect.error.error).toBe('invalid_request');

        const unknownScope: AuthorizationFailure = expectAuthorizationFailure(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            scope: 'admin',
        }));
        expect(unknownScope.error.error).toBe('invalid_scope');
        expect(unknownScope.redirect).toEqual({redirectUri: REDIRECT_URI, state: 'state-value'});
    });

    it('validateAuthorizationRequest matches a loopback redirect_uri on any port, as RFC 8252 requires for native clients', async () => {
        clients.clients.set('native-client', {
            clientId: 'native-client',
            clientName: 'Native client',
            redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback', 'https://client.example/callback'],
            source: 'registered',
        });
        const nativeQuery: Record<string, string> = {...VALID_QUERY, client_id: 'native-client'};

        const localhost: AuthorizationRequest = expectAuthorizationRequest(await server.validateAuthorizationRequest({
            ...nativeQuery,
            redirect_uri: 'http://localhost:52979/callback',
        }));
        expect(localhost.redirectUri).toBe('http://localhost:52979/callback');

        const ipv4: AuthorizationRequest = expectAuthorizationRequest(await server.validateAuthorizationRequest({
            ...nativeQuery,
            redirect_uri: 'http://127.0.0.1:61000/callback',
        }));
        expect(ipv4.redirectUri).toBe('http://127.0.0.1:61000/callback');

        for (const redirectUri of [
            'http://localhost:52979/other',
            'http://localhost:52979/callback?next=1',
            'http://[::1]:52979/callback',
            'https://client.example:8443/callback',
        ]) {
            const rejected: AuthorizationFailure = expectAuthorizationFailure(await server.validateAuthorizationRequest({
                ...nativeQuery,
                redirect_uri: redirectUri,
            }));
            expect(rejected.error.error).toBe('invalid_request');
            expect(rejected.redirect).toBeNull();
        }
    });

    it('validateAuthorizationRequest returns redirect only after the client and redirect URI are verified', async () => {
        const unknownClient: AuthorizationFailure = expectAuthorizationFailure(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            client_id: 'unknown-client',
        }));
        expect(unknownClient.error.error).toBe('invalid_client');
        expect(unknownClient.redirect).toBeNull();

        const unregisteredRedirect: AuthorizationFailure = expectAuthorizationFailure(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            redirect_uri: 'https://attacker.example/callback',
        }));
        expect(unregisteredRedirect.error.error).toBe('invalid_request');
        expect(unregisteredRedirect.redirect).toBeNull();

        const badScope: AuthorizationFailure = expectAuthorizationFailure(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            scope: 'admin',
        }));
        expect(badScope.error.error).toBe('invalid_scope');
        expect(badScope.redirect).toEqual({redirectUri: REDIRECT_URI, state: 'state-value'});
    });

    it('validateAuthorizationRequest accepts a registered client, defaults to all supported scopes and resolves an https client_id through the metadata document fetcher', async () => {
        const registered: AuthorizationRequest = expectAuthorizationRequest(await server.validateAuthorizationRequest(VALID_QUERY));
        expect(registered).toEqual({
            clientId: REGISTERED_CLIENT.clientId,
            clientName: REGISTERED_CLIENT.clientName,
            redirectUri: REDIRECT_URI,
            state: 'state-value',
            scope: ['read', 'messages'],
            resource: RESOURCE,
            codeChallenge: RFC_CHALLENGE,
            codeChallengeMethod: 'S256',
        });

        const emptyScope: AuthorizationRequest = expectAuthorizationRequest(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            scope: '',
        }));
        expect(emptyScope.scope).toEqual(CONFIG.scopesSupported);

        const queryWithoutScope: Record<string, string> = {...VALID_QUERY};
        delete queryWithoutScope.scope;
        const missingScope: AuthorizationRequest = expectAuthorizationRequest(await server.validateAuthorizationRequest(queryWithoutScope));
        expect(missingScope.scope).toEqual(CONFIG.scopesSupported);

        const metadata: AuthorizationRequest = expectAuthorizationRequest(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            client_id: METADATA_CLIENT_URL,
            scope: 'read',
        }));
        expect(metadata.clientId).toBe(METADATA_CLIENT_URL);
        expect(metadata.clientName).toBe('Metadata client');
    });

    it('validateAuthorizationRequest rejects a state longer than 512 characters', async () => {
        const result: AuthorizationFailure = expectAuthorizationFailure(await server.validateAuthorizationRequest({
            ...VALID_QUERY,
            state: 'x'.repeat(513),
        }));

        expect(result.error.error).toBe('invalid_request');
        expect(result.redirect).toBeNull();
    });

    it('validateAuthorizationRequest keeps invalid_client when the metadata fetch fails and logs the cause', async () => {
        const logger: AbstractLogger & {warning: jest.Mock} = loggerStub();
        const failingServer: OAuthAuthorizationServer = buildServer(clients, failingMetadataFetcher(), logger);

        const result: AuthorizationFailure = expectAuthorizationFailure(await failingServer.validateAuthorizationRequest({
            ...VALID_QUERY,
            client_id: METADATA_CLIENT_URL,
        }));

        expect(result.error.error).toBe('invalid_client');
        expect(result.redirect).toBeNull();
        expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('metadata unavailable'));
    });

    it('metadata advertises S256 only, iss parameter support and client id metadata documents', () => {
        const metadata: OAuthServerMetadata = server.metadata();

        expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
        expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
        expect(metadata.client_id_metadata_document_supported).toBe(true);
        expect(metadata.authorization_endpoint).toBe(CONFIG.endpoints.authorization);
        expect(metadata.token_endpoint).toBe(CONFIG.endpoints.token);
        expect(metadata.registration_endpoint).toBe(CONFIG.endpoints.registration);
        expect(metadata.revocation_endpoint).toBe(CONFIG.endpoints.revocation);
        expect(metadata.scopes_supported).toEqual(CONFIG.scopesSupported);
    });

    it('register accepts a public client with authorization_code, refresh_token and code', async () => {
        const result: OAuthClient | OAuthError = await server.register({
            client_name: 'Native application',
            redirect_uris: ['http://127.0.0.1:7777/callback'],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
        });

        if ('error' in result) {
            throw new Error(`Unexpected OAuth error: ${result.error}`);
        }

        expect(result.clientId.length).toBeGreaterThan(0);
        expect(result.clientName).toBe('Native application');
        expect(result.redirectUris).toEqual(['http://127.0.0.1:7777/callback']);
        expect(result.source).toBe('registered');
        expect(clients.saved).toEqual([result]);

        const defaults: OAuthClient | OAuthError = await server.register({
            redirect_uris: ['http://localhost:3000/callback'],
        });
        expect(defaults).not.toHaveProperty('error');
    });

    it('register rejects confidential clients, unsupported grants, response types and redirect URIs', async () => {
        const confidential: OAuthClient | OAuthError = await server.register({
            redirect_uris: [REDIRECT_URI],
            token_endpoint_auth_method: 'client_secret_basic',
        });
        expect(confidential).toHaveProperty('error', 'invalid_client_metadata');

        const unsupportedGrant: OAuthClient | OAuthError = await server.register({
            redirect_uris: [REDIRECT_URI],
            grant_types: ['client_credentials'],
        });
        expect(unsupportedGrant).toHaveProperty('error', 'invalid_client_metadata');

        const unsupportedResponse: OAuthClient | OAuthError = await server.register({
            redirect_uris: [REDIRECT_URI],
            response_types: ['token'],
        });
        expect(unsupportedResponse).toHaveProperty('error', 'invalid_client_metadata');

        const unsafeRedirect: OAuthClient | OAuthError = await server.register({
            redirect_uris: ['http://client.example/callback'],
        });
        expect(unsafeRedirect).toHaveProperty('error', 'invalid_redirect_uri');

        const trailingHash: OAuthClient | OAuthError = await server.register({
            redirect_uris: [`${REDIRECT_URI}#`],
        });
        expect(trailingHash).toHaveProperty('error', 'invalid_redirect_uri');

        const missingRedirect: OAuthClient | OAuthError = await server.register({});
        expect(missingRedirect).toHaveProperty('error', 'invalid_redirect_uri');
    });

    it('register limits redirect_uris to 10 entries of at most 2048 characters each', async () => {
        const manyRedirectUris: string[] = [];
        for (let index: number = 0; index < 11; index += 1) {
            manyRedirectUris.push(`https://client.example/callback-${index}`);
        }
        const tooMany: OAuthClient | OAuthError = await server.register({redirect_uris: manyRedirectUris});
        expect(tooMany).toHaveProperty('error', 'invalid_redirect_uri');

        const tooLong: OAuthClient | OAuthError = await server.register({
            redirect_uris: [`https://client.example/${'x'.repeat(2048)}`],
        });
        expect(tooLong).toHaveProperty('error', 'invalid_redirect_uri');

        const maximum: OAuthClient | OAuthError = await server.register({
            redirect_uris: [`https://client.example/${'x'.repeat(2025)}`],
        });
        expect(maximum).not.toHaveProperty('error');
    });
});
