import {PoolClient} from "pg";

export interface AdvisoryLockSource {
    getClient(): Promise<PoolClient>;
}

/**
 * PostgreSQL advisory locks. `xact` takes the lock for the rest of the current transaction and
 * hashes a text key (`pg_advisory_xact_lock(int, hashtext(text))`); `withSession` takes a session
 * lock on a dedicated connection for the duration of `fn`, so it also serializes across servers.
 */
export class AdvisoryLock {
    public static async xact(client: PoolClient, namespace: number, key: string): Promise<void> {
        await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2::text));', [namespace, key]);
    }

    /** Like `xact`, but does not wait: false when another session holds the lock (the caller skips its work). */
    public static async tryXact(client: PoolClient, namespace: number, key: string): Promise<boolean> {
        const result = await client.query('SELECT pg_try_advisory_xact_lock($1::int, hashtext($2::text)) AS acquired;', [namespace, key]);
        return result.rows[0]?.acquired === true;
    }

    public static async withSession<T>(
        db: AdvisoryLockSource,
        namespace: number,
        key: number,
        fn: () => Promise<T>,
    ): Promise<T> {
        const client: PoolClient = await db.getClient();
        try {
            await client.query('SELECT pg_advisory_lock($1::int, $2::int);', [namespace, key]);
            return await fn();
        } finally {
            try {
                await client.query('SELECT pg_advisory_unlock($1::int, $2::int);', [namespace, key]);
            } finally {
                client.release();
            }
        }
    }
}
