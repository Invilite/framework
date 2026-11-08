export const DATABASE_OPERATION_SLOW_EVENT: string = 'database.operation.slow';

export enum DatabaseOperationKind {
    /** A statement sent to the server, measured from send to result (or error). */
    Query = 'query',
    /** Waiting for a free connection from the pool - grows when the pool is exhausted. */
    PoolAcquire = 'pool-acquire',
}

export enum DatabaseSlowSeverity {
    Slow = 'slow',
    VerySlow = 'very-slow',
}

export interface DatabaseSlowOperationThresholds {
    slowMs: number;
    verySlowMs: number;
}

/**
 * Emitted on the EventBus by `PgClient` when a query or a pool acquire crosses a threshold.
 * Carries the SQL text only - parameter values never leave the client, they may hold personal data.
 */
export default interface DatabaseSlowOperationEvent {
    operation: DatabaseOperationKind;
    severity: DatabaseSlowSeverity;
    durationMs: number;
    thresholdMs: number;
    poolTotalCount: number;
    poolIdleCount: number;
    poolWaitingCount: number;
    parameterCount: number;
    failed: boolean;
    sql: string | null;
}
