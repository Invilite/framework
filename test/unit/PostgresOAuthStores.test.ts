import PgClient from '../../src/infrastructure/Database/PgClient';
import {PostgresOAuthStores} from '../../src/services/OAuth/PostgresOAuthStores';
import {OAuthAuthorizationCode, OAuthGrant} from '../../src/services/OAuth/OAuthTypes';

interface QueryCall {
    sql: string;
    params: unknown[];
}

function fakeDb(rowsByCall: unknown[][]): {db: PgClient; calls: QueryCall[]} {
    const calls: QueryCall[] = [];
    let callIndex: number = 0;
    const query = jest.fn(async (sql: string, params: unknown[]): Promise<{rows: unknown[]; rowCount: number}> => {
        calls.push({sql, params});
        const rows: unknown[] = rowsByCall[callIndex] ?? [];
        callIndex += 1;

        return {rows, rowCount: rows.length};
    });

    return {db: {query} as unknown as PgClient, calls};
}

describe('PostgresOAuthStores', () => {
    it('saves a client with its redirect URIs as jsonb and upserts on client_id', async () => {
        const {db, calls} = fakeDb([[]]);
        const stores: PostgresOAuthStores = new PostgresOAuthStores(db);

        await stores.clients.save({
            clientId: 'https://client.example/client.json',
            clientName: 'Metadata client',
            redirectUris: ['https://client.example/callback'],
            source: 'metadata_document',
        });

        expect(calls[0].sql).toContain('INSERT INTO public.oauth_clients');
        expect(calls[0].sql).toContain('ON CONFLICT (client_id) DO UPDATE');
        expect(calls[0].params).toEqual([
            'https://client.example/client.json',
            'metadata_document',
            'Metadata client',
            JSON.stringify(['https://client.example/callback']),
        ]);
    });

    it('consume marks a code used atomically and returns the row, or null when the code was already used', async () => {
        const usedAt: Date = new Date('2026-10-28T12:00:00.000Z');
        const row: Record<string, unknown> = {
            grant_id: 5,
            code_hash: 'hash',
            code_challenge: 'challenge',
            redirect_uri: 'https://client.example/callback',
            resource: 'https://auth.example/mcp',
            expires_at: new Date('2026-10-28T12:05:00.000Z'),
            used_at: usedAt,
        };
        const {db, calls} = fakeDb([[row], []]);
        const stores: PostgresOAuthStores = new PostgresOAuthStores(db);

        const consumed: OAuthAuthorizationCode | null = await stores.codes.consume('hash');
        expect(consumed).toEqual({
            grantId: 5,
            codeHash: 'hash',
            codeChallenge: 'challenge',
            redirectUri: 'https://client.example/callback',
            resource: 'https://auth.example/mcp',
            expiresAt: new Date('2026-10-28T12:05:00.000Z'),
            usedAt,
        });
        expect(calls[0].sql).toContain('SET used_at = NOW()');
        expect(calls[0].sql).toContain('used_at IS NULL');
        expect(calls[0].sql).toContain('RETURNING');

        await expect(stores.codes.consume('hash')).resolves.toBeNull();
    });

    it('rotates a refresh token in one statement that marks the old token used and inserts the new one', async () => {
        const {db, calls} = fakeDb([[{grant_id: 5}], []]);
        const stores: PostgresOAuthStores = new PostgresOAuthStores(db);
        const expiresAt: Date = new Date('2026-11-27T12:00:00.000Z');

        await expect(stores.refreshTokens.rotate('old-hash', {
            grantId: 5,
            tokenHash: 'new-hash',
            createdAt: new Date('2026-10-28T12:00:00.000Z'),
            expiresAt,
        })).resolves.toBe(true);

        expect(calls).toHaveLength(1);
        expect(calls[0].sql).toContain('WITH consumed AS');
        expect(calls[0].sql).toContain('UPDATE public.oauth_refresh_tokens');
        expect(calls[0].sql).toContain('used_at IS NULL');
        expect(calls[0].sql).toContain('INSERT INTO public.oauth_refresh_tokens');

        await expect(stores.refreshTokens.rotate('used-hash', {
            grantId: 5,
            tokenHash: 'other-hash',
            createdAt: new Date('2026-10-28T12:00:00.000Z'),
            expiresAt,
        })).resolves.toBe(false);
    });

    it('creates or renews a grant and maps the persisted row', async () => {
        const createdAt: Date = new Date('2026-10-28T12:00:00.000Z');
        const {db, calls} = fakeDb([[{
            id: 3,
            user_id: 7,
            client_id: 'registered-client',
            scope: 'read messages',
            created_at: createdAt,
            last_used_at: null,
            revoked_at: null,
        }]]);
        const stores: PostgresOAuthStores = new PostgresOAuthStores(db);

        const grant: OAuthGrant = await stores.grants.createOrRenew({
            userId: 7,
            clientId: 'registered-client',
            scope: ['read', 'messages'],
        });

        expect(grant).toEqual({
            id: 3,
            userId: 7,
            clientId: 'registered-client',
            scope: ['read', 'messages'],
            createdAt,
            lastUsedAt: null,
            revokedAt: null,
        });
        expect(calls[0].sql).toContain('ON CONFLICT (user_id, client_id) WHERE revoked_at IS NULL');
        expect(calls[0].sql).not.toContain('revoked_at = NULL');
        expect(calls[0].params).toEqual([7, 'registered-client', 'read messages']);
    });

    it('revokes grants and refresh tokens for the given users only', async () => {
        const {db, calls} = fakeDb([[], [], []]);
        const stores: PostgresOAuthStores = new PostgresOAuthStores(db);

        await stores.grants.revokeAllForUsers([7, 8]);
        await stores.refreshTokens.revokeAllForUsers([7, 8]);

        expect(calls[0].sql).toContain('UPDATE public.oauth_grants');
        expect(calls[0].sql).toContain('user_id = ANY($1)');
        expect(calls[0].params).toEqual([[7, 8]]);
        expect(calls[1].sql).toContain('UPDATE public.oauth_refresh_tokens');
        expect(calls[1].sql).toContain('FROM public.oauth_grants');
        expect(calls[1].sql).toContain('user_id = ANY($1)');
        expect(calls[1].params).toEqual([[7, 8]]);
    });

    it('does not issue an UPDATE for an empty user list', async () => {
        const {db, calls} = fakeDb([[], []]);
        const stores: PostgresOAuthStores = new PostgresOAuthStores(db);

        await stores.grants.revokeAllForUsers([]);
        await stores.refreshTokens.revokeAllForUsers([]);

        expect(calls).toHaveLength(0);
    });
});
