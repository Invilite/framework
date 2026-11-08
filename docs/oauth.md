# OAuth 2.1 authorization server

`src/services/OAuth/` is a complete, narrow OAuth 2.1 authorization server: authorization request validation, client registration, code issuance, the exchange for tokens, refresh token rotation and revocation. It is generic and shared by any project that needs one.

The module:

- knows no users, visibility rules or protected resources: they arrive through configuration and interfaces,
- renders no pages: the consent screen and the connected applications list belong to the application,
- has no session of its own: the application supplies the user identity.

## Files

| File | Responsibility |
|---|---|
| `OAuthAuthorizationServer.ts` | Metadata, authorization request validation, registration, code issuance, code and refresh token exchange, rotation, revocation. |
| `OAuthTypes.ts` | Contracts: client, grant, code, refresh token, stores, configuration, responses, error codes. |
| `ClientMetadataFetcher.ts` | Fetching the Client ID Metadata Document over HTTPS with SSRF protection and a cache; transport and address blocking come from the shared `SafeHttpsFetcher` in `src/utils/SafeHttpsFetch.ts`. |
| `Pkce.ts` | PKCE `S256` verification (`code_verifier` 43-128 characters, `code_challenge` 43 base64url characters). |
| `RedirectUriPolicy.ts` | Allowed `redirect_uri`: HTTPS, or HTTP only for `localhost`, `127.0.0.1`, `[::1]`; no fragment, no credentials. `isRegisteredRedirectUri`: exact match with the registered URI, except that a loopback HTTP URI matches any port (RFC 8252 section 7.3). |
| `PostgresOAuthStores.ts` | Client, code, grant and refresh token stores on raw SQL over `PgClient`. |

## Configuration and extension points

`OAuthServerConfig` carries `issuer`, `resource`, `scopesSupported`, `accessTokenTtlSeconds`, `refreshTokenTtlSeconds`, `codeTtlSeconds` and the four endpoint URLs (`authorization`, `token`, `registration`, `revocation`). The application also provides:

- `OAuthStores`: the store implementations; the module ships `PostgresOAuthStores` for PostgreSQL,
- `OAuthAccessTokenSigner`: a function `(claims, ttl, audience) => Promise<string>`; an application typically wraps its own token minting, so access tokens are signed with the same key as its sessions,
- `OAuthUserIdentity.isActive(userId)`: the account check made on every refresh,
- a `ClientMetadataFetcher` for Client ID Metadata Documents.

The constructor also takes an optional logger. The module needs no `EventBus` and no message broker; when the application revokes accounts (for example on its own token revocation events), it calls `revokeUserGrants` itself.

## Flow

1. **Authorization request validation** (`validateAuthorizationRequest`): `client_id` present, the client known, its `redirect_uri` registered, `response_type=code`, PKCE `S256`, `resource` equal to the configured one, scope within `scopesSupported` (a missing `scope` means all of them). `state` up to 512 characters. A failure after the client and its redirect URI were verified returns a redirect target, so the error goes back to the client; an earlier failure ends on the application's error page.
2. **Client**: a `client_id` that is an HTTPS URL names a metadata document fetched on demand; any other `client_id` is a client registered in the store.
3. **Code issuance** (`issueCode`): stores or renews the consent, stores the code hash with the `code_challenge`, `redirect_uri`, `resource` and expiry, and returns the redirect with `code`, `state` and `iss`.
4. **Code exchange** (`exchange` with `grant_type=authorization_code`): the code is single-use (`consume` marks it atomically), the client, `redirect_uri` and `resource` must match, the code must be valid and PKCE must verify. A second attempt with the same code revokes the grant.
5. **Refresh** (`exchange` with `grant_type=refresh_token`): checks the client, the grant, validity, that the token is unused and the account active, then rotates the refresh token (`rotate` atomically marks the old one and stores the new). Reuse of the old token revokes the grant.
6. **Revocation**: `revoke` (RFC 7009) takes a refresh token and optionally `client_id`. An unknown token succeeds without changing anything. A `client_id` that differs from the grant's client also changes nothing; an absent `client_id` revokes the grant, which RFC 7009 leaves to the client authentication this module does not do. Since every client here is public, the application's revocation route must require `client_id` before calling `revoke`, so one client cannot revoke another client's token. `revokeGrant` and `revokeUserGrants` revoke a grant, or the grants of users, together with all their refresh tokens.

Dynamic registration (`register`) accepts public clients only: `token_endpoint_auth_method` must be `none` (the default), grant types only `authorization_code` and `refresh_token`, `response_type` only `code`, and 1 to 10 redirect URIs, each at most 2048 characters and passing the redirect policy. The client id is a generated UUID; a missing `client_name` defaults to the host of the first redirect URI.

## Stores and SQL

`PostgresOAuthStores` assembles the four stores: `PostgresOAuthClientStore`, `PostgresOAuthGrantStore`, `PostgresOAuthCodeStore`, `PostgresOAuthRefreshTokenStore`, all on raw SQL through one `PgClient`. The tables live in the `public` schema: `oauth_clients`, `oauth_grants`, `oauth_codes`, `oauth_refresh_tokens`.

Every secret (code, refresh token) is stored as its SHA-256 hash; the access token is a JWT signed by the application and has no database row. `oauth_grants` is unique on `(user_id, client_id)` among non-revoked rows, so a repeated consent from the same client renews the existing row instead of creating a second one; after a revocation a new consent creates a fresh row.

## Database schema

The package ships no migration: the application creates the tables with the DDL below. `oauth_grants.user_id` references the application's own users table; the `integer` type here follows that table's primary key, so adapt it if the application uses `bigint` or a `uuid`.

```sql
CREATE TABLE public.oauth_clients
(
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id     text NOT NULL UNIQUE,
    source        text NOT NULL,
    client_name   text NOT NULL,
    redirect_uris jsonb NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT oauth_clients_source_check CHECK (source IN ('metadata_document', 'registered'))
);

CREATE TABLE public.oauth_grants
(
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      integer NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
    client_id    text NOT NULL REFERENCES public.oauth_clients (client_id) ON DELETE CASCADE,
    scope        text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT NOW(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
CREATE UNIQUE INDEX oauth_grants_user_client_active_key
    ON public.oauth_grants (user_id, client_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_oauth_grants_user ON public.oauth_grants (user_id);
CREATE INDEX idx_oauth_grants_client_id ON public.oauth_grants (client_id);

CREATE TABLE public.oauth_codes
(
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    grant_id       bigint NOT NULL REFERENCES public.oauth_grants (id) ON DELETE CASCADE,
    code_hash      text NOT NULL UNIQUE,
    code_challenge text NOT NULL,
    redirect_uri   text NOT NULL,
    resource       text NOT NULL,
    expires_at     timestamptz NOT NULL,
    used_at        timestamptz
);
CREATE INDEX idx_oauth_codes_grant ON public.oauth_codes (grant_id);

CREATE TABLE public.oauth_refresh_tokens
(
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    grant_id   bigint NOT NULL REFERENCES public.oauth_grants (id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    revoked_at timestamptz
);
CREATE INDEX idx_oauth_refresh_tokens_grant ON public.oauth_refresh_tokens (grant_id);
```

The stores look rows up by `client_id`, `code_hash`, `token_hash` and the grant `id`. The grants upsert (`createOrRenew`) conflicts on the partial unique index `oauth_grants_user_client_active_key`, so a revoked grant is never revived. The `grant_id`, `user_id` and `client_id` indexes serve the revocation queries and the cascading deletes.

## Security

- **PKCE `S256` only**; `code_verifier` and `code_challenge` are checked against their patterns and compared in constant time.
- **Redirect URIs**: HTTPS, or loopback HTTP; no fragment and no credentials; at registration each URI is limited to 2048 characters and at most 10 are accepted.
- **Metadata document fetch**: HTTPS on port 443 only, a 5 s timeout and a 64 KiB limit, DNS resolved before connecting and the answer pinned, private, local, link-local, documentation, multicast and further IPv6 ranges blocked (including `::ffff:0:0:0/96`); successes cached for one hour, failures for one minute, at most 1000 entries. The document must be a JSON object whose `client_id` equals its URL, with valid `redirect_uris`.
- **Public clients**: `token_endpoint_auth_method` only `none`; no client secrets anywhere.
- **Tokens**: the access token carries `aud` equal to the configured resource; the refresh token is single-use and rotated; reuse of a code or a refresh token revokes the grant.
- **Consent**: outside the module; CSRF protection and framing protection on the consent page belong to the application.

## Tests

Unit tests live in `test/unit/`: `OAuthAuthorizationServer.test.ts`, `OAuthPkce.test.ts`, `OAuthTokenEndpoint.test.ts`, `OAuthClientMetadataFetcher.test.ts`, `PostgresOAuthStores.test.ts`. They need no database: the stores are fakes, or the SQL is checked against a stub `PgClient`.
