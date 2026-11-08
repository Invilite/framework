import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {AbstractLogger} from '../../types/interfaces/AbstractLogger';
import {ClientMetadataFetcher} from './ClientMetadataFetcher';
import {
    AuthorizationRequest,
    AuthorizationRequestResult,
    NewOAuthGrant,
    NewOAuthRefreshToken,
    OAuthAccessTokenClaims,
    OAuthAccessTokenSigner,
    OAuthAuthorizationCode,
    OAuthClient,
    OAuthClientSource,
    OAuthError,
    OAuthErrorCode,
    OAuthGrant,
    OAuthRedirectTarget,
    OAuthRefreshToken,
    OAuthServerConfig,
    OAuthServerMetadata,
    OAuthStores,
    OAuthUserIdentity,
    TokenResponse,
} from './OAuthTypes';
import {Pkce} from './Pkce';
import {isAllowedRedirectUri, isRegisteredRedirectUri} from './RedirectUriPolicy';

const ALLOWED_GRANT_TYPES: string[] = ['authorization_code', 'refresh_token'];
const ALLOWED_RESPONSE_TYPES: string[] = ['code'];
const MAX_STATE_LENGTH: number = 512;
const MAX_REDIRECT_URIS: number = 10;
const MAX_REDIRECT_URI_LENGTH: number = 2048;

function oauthError(error: OAuthErrorCode, errorDescription: string): OAuthError {
    return {error, errorDescription};
}

function generateToken(): string {
    return randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function isNonEmptyStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.length > 0 && value.every((item: unknown): item is string => typeof item === 'string');
}

function parseScope(raw: string | undefined): string[] {
    if (!raw) {
        return [];
    }

    const scope: string[] = [];
    for (const value of raw.split(/\s+/)) {
        if (value.length > 0 && !scope.includes(value)) {
            scope.push(value);
        }
    }

    return scope;
}

export class OAuthAuthorizationServer {
    public constructor(
        private readonly config: OAuthServerConfig,
        private readonly stores: OAuthStores,
        private readonly clientMetadataFetcher: ClientMetadataFetcher,
        private readonly accessTokenSigner: OAuthAccessTokenSigner,
        private readonly userIdentity: OAuthUserIdentity,
        private readonly logger?: AbstractLogger,
    ) {
    }

    public metadata(): OAuthServerMetadata {
        return {
            issuer: this.config.issuer,
            authorization_endpoint: this.config.endpoints.authorization,
            token_endpoint: this.config.endpoints.token,
            registration_endpoint: this.config.endpoints.registration,
            revocation_endpoint: this.config.endpoints.revocation,
            response_types_supported: ['code'],
            response_modes_supported: ['query'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none'],
            revocation_endpoint_auth_methods_supported: ['none'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: this.config.scopesSupported,
            authorization_response_iss_parameter_supported: true,
            client_id_metadata_document_supported: true,
        };
    }

    public async validateAuthorizationRequest(query: Record<string, string>): Promise<AuthorizationRequestResult> {
        const state: string | null = query.state ?? null;
        if (state !== null && state.length > MAX_STATE_LENGTH) {
            return {ok: false, error: oauthError('invalid_request', 'state is too long'), redirect: null};
        }

        const clientId: string | undefined = query.client_id;
        if (!clientId) {
            return {ok: false, error: oauthError('invalid_request', 'client_id is required'), redirect: null};
        }

        const redirectUri: string | undefined = query.redirect_uri;
        if (!redirectUri) {
            return {ok: false, error: oauthError('invalid_request', 'redirect_uri is required'), redirect: null};
        }
        if (!isAllowedRedirectUri(redirectUri)) {
            return {
                ok: false,
                error: oauthError('invalid_request', 'redirect_uri must be HTTPS or a loopback HTTP URL'),
                redirect: null,
            };
        }

        const client: OAuthClient | null = await this.resolveClient(clientId);
        if (!client) {
            return {ok: false, error: oauthError('invalid_client', 'unknown client'), redirect: null};
        }
        if (!isRegisteredRedirectUri(client.redirectUris, redirectUri)) {
            return {
                ok: false,
                error: oauthError('invalid_request', 'redirect_uri is not registered for this client'),
                redirect: null,
            };
        }

        const redirect: OAuthRedirectTarget = {redirectUri, state};
        const failure = (error: OAuthError): AuthorizationRequestResult => ({ok: false, error, redirect});

        if (query.response_type !== 'code') {
            return failure(oauthError('unsupported_response_type', 'response_type must be code'));
        }

        const codeChallenge: string | undefined = query.code_challenge;
        if (!codeChallenge) {
            return failure(oauthError('invalid_request', 'code_challenge is required'));
        }
        if (query.code_challenge_method !== 'S256') {
            return failure(oauthError('invalid_request', 'code_challenge_method must be S256'));
        }
        if (!Pkce.isValidChallenge(codeChallenge)) {
            return failure(oauthError('invalid_request', 'code_challenge is malformed'));
        }

        const resource: string | undefined = query.resource;
        if (!resource) {
            return failure(oauthError('invalid_request', 'resource is required'));
        }
        if (resource !== this.config.resource) {
            return failure(oauthError('invalid_request', 'resource is not supported'));
        }

        const scope: string[] = query.scope && query.scope.trim().length > 0
            ? parseScope(query.scope)
            : [...this.config.scopesSupported];
        const unsupported: string[] = scope.filter((value: string): boolean => !this.config.scopesSupported.includes(value));
        if (unsupported.length > 0) {
            return failure(oauthError('invalid_scope', 'requested scope is not supported'));
        }

        return {
            ok: true,
            request: {
                clientId: client.clientId,
                clientName: client.clientName,
                redirectUri,
                state,
                scope,
                resource,
                codeChallenge,
                codeChallengeMethod: 'S256',
            },
        };
    }

    public async issueCode(grant: NewOAuthGrant, request: AuthorizationRequest): Promise<{redirectTo: string}> {
        const existingClient: OAuthClient | null = await this.stores.clients.find(request.clientId);
        const redirectUris: string[] = existingClient
            ? Array.from(new Set<string>([...existingClient.redirectUris, request.redirectUri]))
            : [request.redirectUri];
        await this.stores.clients.save({
            clientId: request.clientId,
            clientName: request.clientName,
            redirectUris,
            source: existingClient?.source ?? OAuthAuthorizationServer.clientSource(request.clientId),
        });
        const storedGrant: OAuthGrant = await this.stores.grants.createOrRenew(grant);

        const code: string = generateToken();
        await this.stores.codes.save({
            grantId: storedGrant.id,
            codeHash: hashToken(code),
            codeChallenge: request.codeChallenge,
            redirectUri: request.redirectUri,
            resource: request.resource,
            expiresAt: new Date(Date.now() + this.config.codeTtlSeconds * 1000),
        });

        const redirect: URL = new URL(request.redirectUri);
        redirect.searchParams.set('code', code);
        if (request.state !== null) {
            redirect.searchParams.set('state', request.state);
        }
        redirect.searchParams.set('iss', this.config.issuer);

        return {redirectTo: redirect.toString()};
    }

    public async exchange(body: Record<string, string>): Promise<TokenResponse | OAuthError> {
        const grantType: string | undefined = body.grant_type;
        if (!grantType) {
            return oauthError('invalid_request', 'grant_type is required');
        }
        if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
            return oauthError('unsupported_grant_type', 'grant_type is not supported');
        }

        const clientId: string | undefined = body.client_id;
        if (!clientId) {
            return oauthError('invalid_request', 'client_id is required');
        }
        const resource: string = body.resource ?? (grantType === 'refresh_token' ? this.config.resource : '');
        if (!resource) {
            return oauthError('invalid_request', 'resource is required');
        }
        if (resource !== this.config.resource) {
            return oauthError('invalid_request', 'resource is not supported');
        }

        return grantType === 'authorization_code'
            ? await this.exchangeCode(body, clientId)
            : await this.exchangeRefreshToken(body, clientId);
    }

    public async revokeGrant(grantId: number): Promise<void> {
        await this.stores.grants.revoke(grantId);
        await this.stores.refreshTokens.revokeAllForGrant(grantId);
    }

    public async revokeUserGrants(userIds: number[]): Promise<void> {
        if (userIds.length === 0) {
            return;
        }

        await this.stores.grants.revokeAllForUsers(userIds);
        await this.stores.refreshTokens.revokeAllForUsers(userIds);
    }

    /** RFC 7009 treats unknown tokens as already revoked, so invalid input resolves without an error. */
    public async revoke(body: Record<string, string>): Promise<void> {
        const token: string | undefined = body.token;
        if (!token) {
            return;
        }

        const tokenHash: string = hashToken(token);
        const storedToken: OAuthRefreshToken | null = await this.stores.refreshTokens.find(tokenHash);
        if (!storedToken) {
            return;
        }

        const grant: OAuthGrant | null = await this.stores.grants.findById(storedToken.grantId);
        if (!grant || (body.client_id !== undefined && body.client_id !== grant.clientId)) {
            return;
        }

        await this.revokeGrant(grant.id);
    }

    public async register(body: unknown): Promise<OAuthClient | OAuthError> {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            return oauthError('invalid_client_metadata', 'registration body must be a JSON object');
        }

        const document: Record<string, unknown> = body as Record<string, unknown>;
        const authMethod: unknown = document.token_endpoint_auth_method ?? 'none';
        if (authMethod !== 'none') {
            return oauthError('invalid_client_metadata', 'only public clients are supported');
        }

        const grantTypes: unknown = document.grant_types ?? ['authorization_code'];
        if (!isNonEmptyStringArray(grantTypes) || grantTypes.some((value: string): boolean => !ALLOWED_GRANT_TYPES.includes(value))) {
            return oauthError('invalid_client_metadata', 'grant_types may contain only authorization_code and refresh_token');
        }

        const responseTypes: unknown = document.response_types ?? ['code'];
        if (!isNonEmptyStringArray(responseTypes) || responseTypes.some((value: string): boolean => !ALLOWED_RESPONSE_TYPES.includes(value))) {
            return oauthError('invalid_client_metadata', 'response_types may contain only code');
        }

        const redirectUris: unknown = document.redirect_uris;
        if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
            return oauthError('invalid_redirect_uri', 'redirect_uris is required');
        }
        if (redirectUris.length > MAX_REDIRECT_URIS) {
            return oauthError('invalid_redirect_uri', `redirect_uris may contain at most ${MAX_REDIRECT_URIS} entries`);
        }

        const validatedRedirectUris: string[] = [];
        for (const redirectUri of redirectUris) {
            if (typeof redirectUri !== 'string'
                || redirectUri.length > MAX_REDIRECT_URI_LENGTH
                || !isAllowedRedirectUri(redirectUri)) {
                return oauthError('invalid_redirect_uri', 'redirect_uris must be HTTPS or loopback HTTP URLs');
            }
            validatedRedirectUris.push(redirectUri);
        }

        if (document.client_name !== undefined && typeof document.client_name !== 'string') {
            return oauthError('invalid_client_metadata', 'client_name must be a string');
        }

        const providedName: string = typeof document.client_name === 'string' ? document.client_name.trim() : '';
        const client: OAuthClient = {
            clientId: randomUUID(),
            clientName: providedName.length > 0 ? providedName : new URL(validatedRedirectUris[0]).hostname,
            redirectUris: validatedRedirectUris,
            source: 'registered',
        };

        await this.stores.clients.save(client);

        return client;
    }

    private async exchangeCode(body: Record<string, string>, clientId: string): Promise<TokenResponse | OAuthError> {
        const code: string | undefined = body.code;
        if (!code) {
            return oauthError('invalid_request', 'code is required');
        }
        const verifier: string | undefined = body.code_verifier;
        if (!verifier) {
            return oauthError('invalid_request', 'code_verifier is required');
        }
        const redirectUri: string | undefined = body.redirect_uri;
        if (!redirectUri) {
            return oauthError('invalid_request', 'redirect_uri is required');
        }

        const codeHash: string = hashToken(code);
        const storedCode: OAuthAuthorizationCode | null = await this.stores.codes.find(codeHash);
        if (!storedCode) {
            return oauthError('invalid_grant', 'authorization code is invalid');
        }

        const grant: OAuthGrant | null = await this.stores.grants.findById(storedCode.grantId);
        if (!grant || grant.clientId !== clientId) {
            return oauthError('invalid_grant', 'authorization code was not issued to this client');
        }
        if (storedCode.usedAt !== null) {
            await this.revokeGrant(storedCode.grantId);
            return oauthError('invalid_grant', 'authorization code was already used');
        }
        if (grant.revokedAt !== null) {
            return oauthError('invalid_grant', 'grant was revoked');
        }
        if (storedCode.expiresAt.getTime() <= Date.now()) {
            return oauthError('invalid_grant', 'authorization code expired');
        }
        if (storedCode.redirectUri !== redirectUri) {
            return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
        }
        if (storedCode.resource !== this.config.resource) {
            return oauthError('invalid_grant', 'resource does not match the authorization request');
        }
        if (!Pkce.verifyS256(verifier, storedCode.codeChallenge)) {
            return oauthError('invalid_grant', 'PKCE verification failed');
        }

        const consumed: OAuthAuthorizationCode | null = await this.stores.codes.consume(codeHash);
        if (!consumed) {
            await this.revokeGrant(storedCode.grantId);
            return oauthError('invalid_grant', 'authorization code was already used');
        }

        return this.createTokenResponse(grant, grant.scope);
    }

    private async exchangeRefreshToken(body: Record<string, string>, clientId: string): Promise<TokenResponse | OAuthError> {
        const refreshToken: string | undefined = body.refresh_token;
        if (!refreshToken) {
            return oauthError('invalid_request', 'refresh_token is required');
        }

        const tokenHash: string = hashToken(refreshToken);
        const storedToken: OAuthRefreshToken | null = await this.stores.refreshTokens.find(tokenHash);
        if (!storedToken) {
            return oauthError('invalid_grant', 'refresh token is invalid');
        }

        const grant: OAuthGrant | null = await this.stores.grants.findById(storedToken.grantId);
        if (!grant || grant.clientId !== clientId) {
            return oauthError('invalid_grant', 'refresh token was not issued to this client');
        }
        if (storedToken.usedAt !== null) {
            await this.revokeGrant(storedToken.grantId);
            return oauthError('invalid_grant', 'refresh token was already used');
        }
        if (storedToken.revokedAt !== null || grant.revokedAt !== null) {
            return oauthError('invalid_grant', 'grant was revoked');
        }
        if (storedToken.expiresAt.getTime() <= Date.now()) {
            return oauthError('invalid_grant', 'refresh token expired');
        }
        if (!(await this.userIdentity.isActive(grant.userId))) {
            return oauthError('invalid_grant', 'user is not active');
        }

        const accessToken: string = await this.createAccessToken(grant, grant.scope);
        const nextRefreshToken: string = generateToken();
        const now: Date = new Date();
        const next: NewOAuthRefreshToken = {
            grantId: grant.id,
            tokenHash: hashToken(nextRefreshToken),
            createdAt: now,
            expiresAt: new Date(now.getTime() + this.config.refreshTokenTtlSeconds * 1000),
        };
        if (!(await this.stores.refreshTokens.rotate(tokenHash, next))) {
            await this.revokeGrant(storedToken.grantId);
            return oauthError('invalid_grant', 'refresh token was already used');
        }

        return this.tokenResponse(accessToken, nextRefreshToken, grant.scope);
    }

    private async createTokenResponse(grant: OAuthGrant, scope: string[]): Promise<TokenResponse> {
        const accessToken: string = await this.createAccessToken(grant, scope);
        const refreshToken: string = generateToken();
        const now: Date = new Date();
        await this.stores.refreshTokens.save({
            grantId: grant.id,
            tokenHash: hashToken(refreshToken),
            createdAt: now,
            expiresAt: new Date(now.getTime() + this.config.refreshTokenTtlSeconds * 1000),
        });

        return this.tokenResponse(accessToken, refreshToken, scope);
    }

    private async createAccessToken(grant: OAuthGrant, scope: string[]): Promise<string> {
        const claims: OAuthAccessTokenClaims = {
            sub: grant.userId,
            client_id: grant.clientId,
            grant_id: grant.id,
            scope: scope.join(' '),
        };

        return this.accessTokenSigner(claims, this.config.accessTokenTtlSeconds, [this.config.resource]);
    }

    private tokenResponse(accessToken: string, refreshToken: string, scope: string[]): TokenResponse {
        return {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: this.config.accessTokenTtlSeconds,
            refresh_token: refreshToken,
            scope: scope.join(' '),
        };
    }

    private static clientSource(clientId: string): OAuthClientSource {
        return OAuthAuthorizationServer.isMetadataDocumentClientId(clientId) ? 'metadata_document' : 'registered';
    }

    private async resolveClient(clientId: string): Promise<OAuthClient | null> {
        if (OAuthAuthorizationServer.isMetadataDocumentClientId(clientId)) {
            try {
                return await this.clientMetadataFetcher.fetch(clientId);
            } catch (error: unknown) {
                const message: string = error instanceof Error ? error.message : String(error);
                this.logger?.warning(`OAuth client metadata fetch failed for ${clientId}: ${message}`);
                return null;
            }
        }

        return this.stores.clients.find(clientId);
    }

    private static isMetadataDocumentClientId(clientId: string): boolean {
        try {
            return new URL(clientId).protocol === 'https:';
        } catch {
            return false;
        }
    }
}
