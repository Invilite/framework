import {PoolClient, QueryResult, QueryResultRow} from "pg";

export default abstract class AbstractSqlClient {

    protected constructor() {
    }

    public abstract query(sql: string, params: unknown[]): Promise<QueryResult<QueryResultRow>>;
    public abstract getClient(): Promise<PoolClient>;
}