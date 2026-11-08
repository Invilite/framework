export type OAuthClientSource = 'metadata_document' | 'registered';

export interface OAuthClient {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    source: OAuthClientSource;
}

/** Durable clients: dynamic registrations and metadata documents resolved on demand. */
export interface OAuthClientStore {
    find(clientId: string): Promise<OAuthClient | null>;
    save(client: OAuthClient): Promise<void>;
}

export interface NewOAuthAuthorizationCode {
    grantId: number;
    codeHash: string;
    codeChallenge: string;
    redirectUri: string;
    resource: string;
    expiresAt: Date;
}

export interface OAuthAuthorizationCode extends NewOAuthAuthorizationCode {
    usedAt: Date | null;
}

/** Authorization codes; `consume` atomically marks a code as used and returns it. */
export interface OAuthCodeStore {
    save(code: NewOAuthAuthorizationCode): Promise<void>;
    find(codeHash: string): Promise<OAuthAuthorizationCode | null>;
    consume(codeHash: string): Promise<OAuthAuthorizationCode | null>;
}

export interface NewOAuthGrant {
    userId: number;
    clientId: string;
    scope: string[];
}

/** A user's consent for one client. */
export interface OAuthGrant extends NewOAuthGrant {
    id: number;
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
}

export interface OAuthGrantStore {
    createOrRenew(grant: NewOAuthGrant): Promise<OAuthGrant>;
    findById(grantId: number): Promise<OAuthGrant | null>;
    revoke(grantId: number): Promise<void>;
    revokeAllForUsers(userIds: number[]): Promise<void>;
}

export interface NewOAuthRefreshToken {
    grantId: number;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
}

export interface OAuthRefreshToken extends NewOAuthRefreshToken {
    usedAt: Date | null;
    revokedAt: Date | null;
}

/** Refresh tokens; `rotate` marks the current token used and stores its replacement atomically. */
export interface OAuthRefreshTokenStore {
    save(token: NewOAuthRefreshToken): Promise<void>;
    find(tokenHash: string): Promise<OAuthRefreshToken | null>;
    rotate(currentTokenHash: string, next: NewOAuthRefreshToken): Promise<boolean>;
    revokeAllForGrant(grantId: number): Promise<void>;
    revokeAllForUsers(userIds: number[]): Promise<void>;
}

export interface OAuthStores {
    clients: OAuthClientStore;
    codes: OAuthCodeStore;
    grants: OAuthGrantStore;
    refreshTokens: OAuthRefreshTokenStore;
}

export interface OAuthAccessTokenClaims {
    sub: number;
    client_id: string;
    grant_id: number;
    scope: string;
}

export type OAuthAccessTokenSigner = (
    claims: OAuthAccessTokenClaims,
    ttlSeconds: number,
    audience: string[],
) => Promise<string>;

export interface TokenResponse {
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
    refresh_token: string;
    scope: string;
}

export interface OAuthUserIdentity {
    isActive(userId: number): Promise<boolean>;
}

export interface OAuthServerEndpoints {
    authorization: string;
    token: string;
    registration: string;
    revocation: string;
}

export interface OAuthServerConfig {
    issuer: string;
    resource: string;
    scopesSupported: string[];
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    codeTtlSeconds: number;
    endpoints: OAuthServerEndpoints;
}

export type OAuthErrorCode =
    | 'invalid_request'
    | 'invalid_client'
    | 'invalid_grant'
    | 'unauthorized_client'
    | 'unsupported_grant_type'
    | 'unsupported_response_type'
    | 'invalid_scope'
    | 'access_denied'
    | 'server_error'
    | 'invalid_redirect_uri'
    | 'invalid_client_metadata';

export interface OAuthError {
    error: OAuthErrorCode;
    errorDescription: string;
}

export interface AuthorizationRequest {
    clientId: string;
    clientName: string;
    redirectUri: string;
    state: string | null;
    scope: string[];
    resource: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256';
}

/** Where an error may safely be sent after the client and its redirect URI were verified. */
export interface OAuthRedirectTarget {
    redirectUri: string;
    state: string | null;
}

export type AuthorizationRequestResult =
    | {ok: true; request: AuthorizationRequest}
    | {ok: false; error: OAuthError; redirect: OAuthRedirectTarget | null};

export interface OAuthServerMetadata {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    revocation_endpoint: string;
    response_types_supported: string[];
    response_modes_supported: string[];
    grant_types_supported: string[];
    token_endpoint_auth_methods_supported: string[];
    revocation_endpoint_auth_methods_supported: string[];
    code_challenge_methods_supported: string[];
    scopes_supported: string[];
    authorization_response_iss_parameter_supported: boolean;
    client_id_metadata_document_supported: boolean;
}
