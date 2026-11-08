import AbstractSqlClient from "./AbstractSqlClient";
import {Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow} from "pg";
import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {HrTimer} from "../../utils/HrTimer";
import SqlError from "../../errors/ApplicationError/SqlError";
import {SecretValues} from "../../utils/SecretValues";
import {registerPgTypeParsers} from "./PgTypeParsers";
import EventBus from "@invilite/eventbus";
import DatabaseSlowOperationEvent, {
    DATABASE_OPERATION_SLOW_EVENT,
    DatabaseOperationKind,
    DatabaseSlowOperationThresholds,
    DatabaseSlowSeverity,
} from "../../types/interfaces/DatabaseSlowOperationEvent";

export interface PgClientOptions {
    /** Emit `database.operation.slow` above these thresholds; `null` (default) disables measuring. */
    slowOperationThresholds?: DatabaseSlowOperationThresholds | null;
}

export default class PgClient extends AbstractSqlClient {
    protected readonly pool: Pool;
    private static readonly LoggerTag: string = 'PgClient';
    /** node-pg type parsers are process-global; register them exactly once. */
    private static typeParsersRegistered: boolean = false;
    private readonly slowOperationThresholds: DatabaseSlowOperationThresholds | null;

    public constructor(private readonly logger: AbstractLogger, poolConfig: PoolConfig, options: PgClientOptions = {}) {
        super();
        this.slowOperationThresholds = options.slowOperationThresholds ?? null;

        if (!PgClient.typeParsersRegistered) {
            registerPgTypeParsers();
            PgClient.typeParsersRegistered = true;
        }

        this.pool = new Pool(poolConfig);

        this.pool.on('connect', (client: PoolClient): void => {
            logger.debug(`[${PgClient.LoggerTag}] New pool connection established (${this.pool.totalCount} connections in pool)`);
        });

        this.pool.on('remove', (client: PoolClient): void => {
            logger.debug(`[${PgClient.LoggerTag}] Pool connection was removed (${this.pool.totalCount} connections in pool)`);
        });

        this.pool.on('acquire', (client: PoolClient): void => {
            logger.trace(`[${PgClient.LoggerTag}] Connection acquired.`);
        });

        this.pool.on('release', (err: Error, client: PoolClient): void => {
            logger.trace(`[${PgClient.LoggerTag}] Connection released.`);
        });

        this.pool.on('error', (err: Error, client: PoolClient): void => {
            logger.error(err);
        });
    }

    public async getClient(): Promise<PoolClient> {
        const stopAcquireTimer: () => number = HrTimer.startTimer();
        const client: PoolClient = await this.pool.connect();
        this.reportIfSlow(DatabaseOperationKind.PoolAcquire, stopAcquireTimer(), null, 0, false);

        if (!(client as any).__isLoggedQuery) {
            const originalQuery = client.query.bind(client);

            (client as any).query = async (...args: any[]) => {
                const [text, params] = args;
                const sql: string = typeof text === 'string' ? text : (text?.text ?? '');
                const parameterCount: number = Array.isArray(params) ? params.length : 0;
                const stopTimer: () => number = HrTimer.startTimer();
                let result: QueryResult<any>;

                try {
                    result = await (originalQuery as any).apply(client, args);
                } catch (e: any) {
                    const queryDuration: number = stopTimer();
                    const message: string = e.detail ? `${e.message}, ${e.detail}` : e.message;
                    // Error-level logs may leave the process (error tracking) - parameter values stay at debug level.
                    this.logger.critical(`[${PgClient.LoggerTag}] Error: ${message} (${queryDuration} ms, ${parameterCount} params)\n${sql}`);
                    this.logger.debug(`[${PgClient.LoggerTag}] Failed query params: [${PgClient.formatParams(params)}]`);
                    this.reportIfSlow(DatabaseOperationKind.Query, queryDuration, sql, parameterCount, true);
                    throw new SqlError(message, text, params, e.code, e.constraint);
                }

                const queryDuration: number = stopTimer();
                this.logger.debug(`[${PgClient.LoggerTag}] (${queryDuration} ms): ${sql} [${PgClient.formatParams(params)}]`);
                this.reportIfSlow(DatabaseOperationKind.Query, queryDuration, sql, parameterCount, false);

                return result;
            };

            (client as any).__isLoggedQuery = true;
        }


        return client;
    }

    public async query<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<QueryResult<T>> {
        const client: PoolClient = await this.getClient();
        try {
            return await client.query<T>(sql, params);
        } finally {
            client.release();
        }
    }

    public destroyPool(): Promise<void> {
        return this.pool.end();
    }

    private static formatParams(params: unknown): string {
        if (!Array.isArray(params)) {
            return '';
        }
        return params.map((param: unknown): unknown => SecretValues.redactValue(param)).join(', ');
    }

    private reportIfSlow(operation: DatabaseOperationKind, durationMs: number, sql: string | null, parameterCount: number, failed: boolean): void {
        const thresholds: DatabaseSlowOperationThresholds | null = this.slowOperationThresholds;
        if (thresholds === null || durationMs < thresholds.slowMs) {
            return;
        }

        const severity: DatabaseSlowSeverity = durationMs >= thresholds.verySlowMs ? DatabaseSlowSeverity.VerySlow : DatabaseSlowSeverity.Slow;
        const payload: DatabaseSlowOperationEvent = {
            operation,
            severity,
            durationMs,
            thresholdMs: severity === DatabaseSlowSeverity.VerySlow ? thresholds.verySlowMs : thresholds.slowMs,
            poolTotalCount: this.pool.totalCount,
            poolIdleCount: this.pool.idleCount,
            poolWaitingCount: this.pool.waitingCount,
            parameterCount,
            failed,
            sql,
        };

        try {
            EventBus.getChannel().emit(DATABASE_OPERATION_SLOW_EVENT, payload);
        } catch (error: unknown) {
            // A failing subscriber must not turn a slow but successful query into an error.
            this.logger.error(`[${PgClient.LoggerTag}] Slow operation subscriber failed:`, error);
        }
    }

}