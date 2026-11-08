import {QueryResult, QueryResultRow} from 'pg';
import PgClient from '../../infrastructure/Database/PgClient';
import {
    NewOAuthAuthorizationCode,
    NewOAuthGrant,
    NewOAuthRefreshToken,
    OAuthAuthorizationCode,
    OAuthClient,
    OAuthClientSource,
    OAuthClientStore,
    OAuthCodeStore,
    OAuthGrant,
    OAuthGrantStore,
    OAuthRefreshToken,
    OAuthRefreshTokenStore,
    OAuthStores,
} from './OAuthTypes';

interface OAuthClientRow extends QueryResultRow {
    client_id: string;
    client_name: string;
    redirect_uris: unknown;
    source: OAuthClientSource;
}

interface OAuthGrantRow extends QueryResultRow {
    id: number;
    user_id: number;
    client_id: string;
    scope: string;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
}

interface OAuthCodeRow extends QueryResultRow {
    grant_id: number;
    code_hash: string;
    code_challenge: string;
    redirect_uri: string;
    resource: string;
    expires_at: Date;
    used_at: Date | null;
}

interface OAuthRefreshTokenRow extends QueryResultRow {
    grant_id: number;
    token_hash: string;
    created_at: Date;
    expires_at: Date;
    used_at: Date | null;
    revoked_at: Date | null;
}

function redirectUrisFromJson(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((item: unknown): item is string => typeof item === 'string');
    }
    if (typeof value === 'string') {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) {
            return parsed.filter((item: unknown): item is string => typeof item === 'string');
        }
    }

    throw new Error('oauth_clients.redirect_uris is not a JSON array');
}

function mapClient(row: OAuthClientRow): OAuthClient {
    return {
        clientId: row.client_id,
        clientName: row.client_name,
        redirectUris: redirectUrisFromJson(row.redirect_uris),
        source: row.source,
    };
}

function mapGrant(row: OAuthGrantRow): OAuthGrant {
    return {
        id: row.id,
        userId: row.user_id,
        clientId: row.client_id,
        scope: row.scope.length > 0 ? row.scope.split(/\s+/) : [],
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
    };
}

function mapCode(row: OAuthCodeRow): OAuthAuthorizationCode {
    return {
        grantId: row.grant_id,
        codeHash: row.code_hash,
        codeChallenge: row.code_challenge,
        redirectUri: row.redirect_uri,
        resource: row.resource,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
    };
}

function mapRefreshToken(row: OAuthRefreshTokenRow): OAuthRefreshToken {
    return {
        grantId: row.grant_id,
        tokenHash: row.token_hash,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        revokedAt: row.revoked_at,
    };
}

export class PostgresOAuthClientStore implements OAuthClientStore {
    public constructor(private readonly db: PgClient) {
    }

    public async find(clientId: string): Promise<OAuthClient | null> {
        const result: QueryResult<OAuthClientRow> = await this.db.query<OAuthClientRow>(
            `SELECT client_id, client_name, redirect_uris, source FROM public.oauth_clients WHERE client_id = $1 LIMIT 1;`,
            [clientId],
        );
        const row: OAuthClientRow | undefined = result.rows[0];

        return row ? mapClient(row) : null;
    }

    public async save(client: OAuthClient): Promise<void> {
        await this.db.query(
            `INSERT INTO public.oauth_clients (client_id, source, client_name, redirect_uris, created_at)
             VALUES ($1, $2, $3, $4::jsonb, NOW())
             ON CONFLICT (client_id) DO UPDATE
             SET source = EXCLUDED.source,
                 client_name = EXCLUDED.client_name,
                 redirect_uris = EXCLUDED.redirect_uris;`,
            [client.clientId, client.source, client.clientName, JSON.stringify(client.redirectUris)],
        );
    }
}

export class PostgresOAuthGrantStore implements OAuthGrantStore {
    public constructor(private readonly db: PgClient) {
    }

    public async createOrRenew(grant: NewOAuthGrant): Promise<OAuthGrant> {
        const result: QueryResult<OAuthGrantRow> = await this.db.query<OAuthGrantRow>(
            `INSERT INTO public.oauth_grants (user_id, client_id, scope, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, client_id) WHERE revoked_at IS NULL
             DO UPDATE
             SET scope = EXCLUDED.scope,
                 last_used_at = NOW()
             RETURNING id, user_id, client_id, scope, created_at, last_used_at, revoked_at;`,
            [grant.userId, grant.clientId, grant.scope.join(' ')],
        );
        const row: OAuthGrantRow | undefined = result.rows[0];
        if (!row) {
            throw new Error('oauth_grants upsert returned no row');
        }

        return mapGrant(row);
    }

    public async findById(grantId: number): Promise<OAuthGrant | null> {
        const result: QueryResult<OAuthGrantRow> = await this.db.query<OAuthGrantRow>(
            `SELECT id, user_id, client_id, scope, created_at, last_used_at, revoked_at
             FROM public.oauth_grants WHERE id = $1 LIMIT 1;`,
            [grantId],
        );
        const row: OAuthGrantRow | undefined = result.rows[0];

        return row ? mapGrant(row) : null;
    }

    public async revoke(grantId: number): Promise<void> {
        await this.db.query(
            `UPDATE public.oauth_grants SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL;`,
            [grantId],
        );
    }

    public async revokeAllForUsers(userIds: number[]): Promise<void> {
        if (userIds.length === 0) {
            return;
        }

        await this.db.query(
            `UPDATE public.oauth_grants SET revoked_at = NOW() WHERE user_id = ANY($1) AND revoked_at IS NULL;`,
            [userIds],
        );
    }
}

export class PostgresOAuthCodeStore implements OAuthCodeStore {
    public constructor(private readonly db: PgClient) {
    }

    public async save(code: NewOAuthAuthorizationCode): Promise<void> {
        await this.db.query(
            `INSERT INTO public.oauth_codes (grant_id, code_hash, code_challenge, redirect_uri, resource, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6);`,
            [code.grantId, code.codeHash, code.codeChallenge, code.redirectUri, code.resource, code.expiresAt],
        );
    }

    public async find(codeHash: string): Promise<OAuthAuthorizationCode | null> {
        const result: QueryResult<OAuthCodeRow> = await this.db.query<OAuthCodeRow>(
            `SELECT grant_id, code_hash, code_challenge, redirect_uri, resource, expires_at, used_at
             FROM public.oauth_codes WHERE code_hash = $1 LIMIT 1;`,
            [codeHash],
        );
        const row: OAuthCodeRow | undefined = result.rows[0];

        return row ? mapCode(row) : null;
    }

    public async consume(codeHash: string): Promise<OAuthAuthorizationCode | null> {
        const result: QueryResult<OAuthCodeRow> = await this.db.query<OAuthCodeRow>(
            `UPDATE public.oauth_codes SET used_at = NOW()
             WHERE code_hash = $1 AND used_at IS NULL
             RETURNING grant_id, code_hash, code_challenge, redirect_uri, resource, expires_at, used_at;`,
            [codeHash],
        );
        const row: OAuthCodeRow | undefined = result.rows[0];

        return row ? mapCode(row) : null;
    }
}

export class PostgresOAuthRefreshTokenStore implements OAuthRefreshTokenStore {
    public constructor(private readonly db: PgClient) {
    }

    public async save(token: NewOAuthRefreshToken): Promise<void> {
        await this.db.query(
            `INSERT INTO public.oauth_refresh_tokens (grant_id, token_hash, created_at, expires_at)
             VALUES ($1, $2, $3, $4);`,
            [token.grantId, token.tokenHash, token.createdAt, token.expiresAt],
        );
    }

    public async find(tokenHash: string): Promise<OAuthRefreshToken | null> {
        const result: QueryResult<OAuthRefreshTokenRow> = await this.db.query<OAuthRefreshTokenRow>(
            `SELECT grant_id, token_hash, created_at, expires_at, used_at, revoked_at
             FROM public.oauth_refresh_tokens WHERE token_hash = $1 LIMIT 1;`,
            [tokenHash],
        );
        const row: OAuthRefreshTokenRow | undefined = result.rows[0];

        return row ? mapRefreshToken(row) : null;
    }

    public async rotate(currentTokenHash: string, next: NewOAuthRefreshToken): Promise<boolean> {
        const result: QueryResult<OAuthRefreshTokenRow> = await this.db.query<OAuthRefreshTokenRow>(
            `WITH consumed AS (
                 UPDATE public.oauth_refresh_tokens
                 SET used_at = NOW()
                 WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
                 RETURNING grant_id
             )
             INSERT INTO public.oauth_refresh_tokens (grant_id, token_hash, created_at, expires_at)
             SELECT grant_id, $2, $3, $4 FROM consumed
             RETURNING grant_id;`,
            [currentTokenHash, next.tokenHash, next.createdAt, next.expiresAt],
        );

        return result.rows.length > 0;
    }

    public async revokeAllForGrant(grantId: number): Promise<void> {
        await this.db.query(
            `UPDATE public.oauth_refresh_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL;`,
            [grantId],
        );
    }

    public async revokeAllForUsers(userIds: number[]): Promise<void> {
        if (userIds.length === 0) {
            return;
        }

        await this.db.query(
            `UPDATE public.oauth_refresh_tokens AS rt SET revoked_at = NOW()
             FROM public.oauth_grants AS g
             WHERE rt.grant_id = g.id
               AND g.user_id = ANY($1)
               AND rt.revoked_at IS NULL;`,
            [userIds],
        );
    }
}

export class PostgresOAuthStores implements OAuthStores {
    public readonly clients: OAuthClientStore;
    public readonly codes: OAuthCodeStore;
    public readonly grants: OAuthGrantStore;
    public readonly refreshTokens: OAuthRefreshTokenStore;

    public constructor(db: PgClient) {
        this.clients = new PostgresOAuthClientStore(db);
        this.codes = new PostgresOAuthCodeStore(db);
        this.grants = new PostgresOAuthGrantStore(db);
        this.refreshTokens = new PostgresOAuthRefreshTokenStore(db);
    }
}
