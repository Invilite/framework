import {PoolClient, QueryResult} from "pg";

export type TransactionClient = PoolClient;

export interface TransactionSource {
    getClient(): Promise<PoolClient>;
}

/**
 * Runs `work` on one pooled connection inside BEGIN/COMMIT, rolling back on any error and always
 * releasing the client. Generic infrastructure: no knowledge of repositories or domains.
 */
export default class PgTransaction {
    public constructor(private readonly db: TransactionSource) {}

    public async run<T>(work: (client: TransactionClient) => Promise<T>): Promise<T> {
        const client: TransactionClient = await this.db.getClient();
        try {
            await client.query('BEGIN');
            const result: T = await work(client);
            const commit: QueryResult = await client.query('COMMIT');
            if (commit.command !== 'COMMIT') {
                throw new Error(`Transaction was rolled back: COMMIT returned "${commit.command}"`);
            }
            return result;
        } catch (error: unknown) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError: unknown) {
                if (error instanceof Error) {
                    (error as Error & {rollbackError?: unknown}).rollbackError = rollbackError;
                }
            }
            throw error;
        } finally {
            client.release();
        }
    }
}
