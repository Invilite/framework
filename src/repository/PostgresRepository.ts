import {PoolClient, QueryResult, QueryResultRow} from "pg";
import AbstractRepository from "./AbstractRepository";
import AbstractModel from "../models/AbstractModel";
import {WithId} from "../types";
import PgClient from "../infrastructure/Database/PgClient";

export default abstract class PostgresRepository<Model extends AbstractModel> extends AbstractRepository<Model> {
    private static readonly IDENTIFIER: RegExp = /^[A-Za-z_][A-Za-z0-9_$]*$/;

    protected readonly db: PgClient
    protected readonly schema: string;
    protected readonly table: string;

    protected constructor(db: PgClient, modelClass:  new () => Model, table: string, schema: string = 'public') {
        super(modelClass);
        PostgresRepository.assertIdentifier(schema, 'schema');
        PostgresRepository.assertIdentifier(table, 'table');
        this.db = db;
        this.table = table;
        this.schema = schema;
    }

    public async getOneByField(field: string, value: unknown, client?: PoolClient): Promise<WithId<Model, number> | null> {
        PostgresRepository.assertIdentifier(field, 'field');
        const query: string = `SELECT * FROM ${this.schema}.${this.table} WHERE ${field} = $1 LIMIT 1;`;
        const data: QueryResultRow | null = await this.queryOne<QueryResultRow>(query, [value], client);

        return data ? this.getModelInstance(data, data.id) : null;
    }

    public async getManyByField(field: string, value: unknown): Promise<WithId<Model, number>[]> {
        PostgresRepository.assertIdentifier(field, 'field');
        const query: string = `SELECT * FROM ${this.schema}.${this.table} WHERE ${field} = $1;`;
        const data: QueryResultRow[] = await this.queryMany<QueryResultRow>(query, [value]);

        return data.map((row: QueryResultRow) => this.getModelInstance(row, row.id));
    }

    public async deleteByField(field: string, value: unknown): Promise<QueryResult<any>> {
        PostgresRepository.assertIdentifier(field, 'field');
        return await this.db.query(`DELETE FROM ${this.schema}.${this.table} WHERE ${field} = $1;`, [value]);
    }

    public async getById(id: number, client?: PoolClient): Promise<WithId<Model, number> | null> {
        return this.getOneByField('id', id, client);
    }

    public async getByIds(ids: number[]): Promise<WithId<Model, number>[]> {
        if (ids.length === 0) {
            return [];
        }

        // ANY($1) - single placeholder for the whole array; works for both integer and bigint
        // columns (PostgreSQL infers the type from the column). Avoids the N-placeholder
        // approach which can hit parameter limits on very large id lists.
        const query: string = `SELECT * FROM ${this.schema}.${this.table} WHERE id = ANY($1);`;
        const rows: QueryResultRow[] = await this.queryMany<QueryResultRow>(query, [ids]);

        return rows.map((row: QueryResultRow) => this.getModelInstance(row, row.id));
    }

    public async deleteById(id: number): Promise<QueryResult<any>> {
        return this.deleteByField('id', id);
    }

    public async insertOne(model: Model, client?: PoolClient): Promise<WithId<Model>> {
        const data: Record<string, any> = model.toJSON();
        const fields: string = Object.keys(data).join(', ');
        const values: unknown[] = Object.values(data);
        const placeholders: string = values.map((_, i: number): string => `$${i + 1}`).join(", ");
        const query: string = `INSERT INTO ${this.schema}.${this.table} (${fields}) VALUES (${placeholders}) RETURNING *`;
        const queryResult: QueryResult<QueryResultRow> = await this.execute<QueryResultRow>(query, values, client);
        const row: QueryResultRow | null = queryResult.rows[0] ?? null;

        if (!row) {
            throw new Error(`INSERT into ${this.schema}.${this.table} returned no row`);
        }

        return this.getModelInstance(row, row.id);
    }

    /** Locks a row for the rest of the transaction; false means the row does not exist. */
    public async lockById(id: number, client: PoolClient): Promise<boolean> {
        const row: QueryResultRow | null = await this.queryOne<QueryResultRow>(
            `SELECT id FROM ${this.schema}.${this.table} WHERE id = $1 FOR UPDATE;`,
            [id],
            client,
        );
        return row !== null;
    }

    /** Shared row lock: blocks writers for the rest of the transaction while allowing other readers. */
    public async lockForShare(id: number, client: PoolClient): Promise<boolean> {
        const row: QueryResultRow | null = await this.queryOne<QueryResultRow>(
            `SELECT id FROM ${this.schema}.${this.table} WHERE id = $1 FOR SHARE;`,
            [id],
            client,
        );
        return row !== null;
    }

    public async updateOne(model: WithId<Model>, client?: PoolClient): Promise<WithId<Model>> {
        const data: Record<string, any> = model.getChangedData();
        const keys: string[] = Object.keys(data);
        const values: unknown[] = Object.values(data);

        if (keys.length === 0) {
            return model;
        }

        const setClause: string = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');

        const query: string = `UPDATE ${this.schema}.${this.table} SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *;`;
        const queryResult: QueryResult<QueryResultRow> = await this.execute<QueryResultRow>(
            query,
            [...values, model.getId()],
            client,
        );

        const row: QueryResultRow | null = queryResult.rows[0] ?? null;
        if (!row) {
            throw new Error(`UPDATE on ${this.schema}.${this.table} for id=${model.getId()} returned no row`);
        }
        return this.getModelInstance(row, row.id);
    }

    protected async execute<ResultRow extends QueryResultRow = QueryResultRow>(
        sql: string,
        params: unknown[],
        client?: PoolClient,
    ): Promise<QueryResult<ResultRow>> {
        return client ? await client.query<ResultRow>(sql, params) : await this.db.query<ResultRow>(sql, params);
    }

    protected async queryOne<ResultRow extends QueryResultRow>(
        sql: string,
        params: unknown[],
        client?: PoolClient,
    ): Promise<ResultRow | null> {
        const queryResult: QueryResult<ResultRow> = await this.execute<ResultRow>(sql, params, client);
        return queryResult.rows[0] ?? null;
    }

    protected async queryMany<ResultRow extends QueryResultRow>(
        sql: string,
        params: unknown[],
        client?: PoolClient,
    ): Promise<ResultRow[]> {
        const queryResult: QueryResult<ResultRow> = await this.execute<ResultRow>(sql, params, client);
        return queryResult.rows;
    }

    public async getAll(): Promise<WithId<Model>[]> {
        const results: QueryResultRow[] = await this.queryMany(`SELECT * FROM ${this.schema}.${this.table};`, []);

        return results.map(row => this.getModelInstance(row, row.id));
    }

    private static assertIdentifier(value: string, kind: string): void {
        if (!PostgresRepository.IDENTIFIER.test(value)) {
            throw new Error(`Invalid ${kind} identifier "${value}"`);
        }
    }
}
