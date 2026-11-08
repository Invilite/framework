import {PoolClient, QueryResultRow} from "pg";
import AbstractModel from "../../src/models/AbstractModel";
import PostgresRepository from "../../src/repository/PostgresRepository";
import PgClient from "../../src/infrastructure/Database/PgClient";
import {WithId} from "../../src/types";

class ItemModel extends AbstractModel {
    protected title: string = '';
    protected likes: number = 0;
    protected status: string = 'published';
    protected tags: string[] = [];
    protected created_at: Date = new Date(0);

    public setTitle(title: string): void {
        this.title = title;
    }

    public setCreatedAt(createdAt: Date): void {
        this.created_at = createdAt;
    }

    public getTags(): string[] {
        return this.tags;
    }
}

class ItemRepository extends PostgresRepository<ItemModel> {
    public constructor(db: PgClient) {
        super(db, ItemModel, 'items', 'public');
    }

    public hydrate(row: QueryResultRow): WithId<ItemModel, number> {
        return this.getModelInstance(row, row.id) as WithId<ItemModel, number>;
    }
}

interface CapturedQuery {
    sql: string;
    params: unknown[];
}

function harness(): {repository: ItemRepository; queries: CapturedQuery[]} {
    const queries: CapturedQuery[] = [];
    const db = {
        query: jest.fn(async (sql: string, params: unknown[]): Promise<{rows: QueryResultRow[]}> => {
            queries.push({sql, params});
            return {rows: [{id: 1, title: 'nowy', likes: 7, status: 'flagged', tags: [], created_at: new Date(0)}]};
        }),
    } as unknown as PgClient;
    return {repository: new ItemRepository(db), queries};
}

const FULL_ROW: QueryResultRow = {id: 1, title: 'stary', likes: 7, status: 'published', tags: ['a'], created_at: new Date(0)};

describe('PostgresRepository.updateOne - zapisuje tylko pola zmienione od odczytu', () => {
    it('zmiana jednego pola daje UPDATE tylko tej kolumny', async () => {
        const {repository, queries} = harness();
        const item: WithId<ItemModel, number> = repository.hydrate(FULL_ROW);

        item.setTitle('nowy');
        await repository.updateOne(item);

        expect(queries).toHaveLength(1);
        expect(queries[0].sql).toBe('UPDATE public.items SET title = $1 WHERE id = $2 RETURNING *;');
        expect(queries[0].params).toEqual(['nowy', 1]);
    });

    it('kolumna nieobecna w odczycie nie jest nadpisywana wartością domyślną modelu', async () => {
        const {repository, queries} = harness();
        const item: WithId<ItemModel, number> = repository.hydrate({id: 1, title: 'stary'});

        item.setTitle('nowy');
        await repository.updateOne(item);

        expect(queries[0].sql).not.toContain('status');
        expect(queries[0].sql).not.toContain('likes');
    });

    it('zmiana tablicy w miejscu jest wykrywana', async () => {
        const {repository, queries} = harness();
        const item: WithId<ItemModel, number> = repository.hydrate(FULL_ROW);

        item.getTags().push('b');
        await repository.updateOne(item);

        expect(queries[0].sql).toBe('UPDATE public.items SET tags = $1 WHERE id = $2 RETURNING *;');
        expect(queries[0].params).toEqual([['a', 'b'], 1]);
    });

    it('ta sama chwila w nowym obiekcie Date nie jest zmianą', async () => {
        const {repository, queries} = harness();
        const item: WithId<ItemModel, number> = repository.hydrate(FULL_ROW);

        item.setCreatedAt(new Date(0));
        await repository.updateOne(item);

        expect(queries).toHaveLength(0);
    });

    it('brak zmian - brak zapytania', async () => {
        const {repository, queries} = harness();
        const item: WithId<ItemModel, number> = repository.hydrate(FULL_ROW);

        const result: WithId<ItemModel, number> = await repository.updateOne(item);

        expect(queries).toHaveLength(0);
        expect(result).toBe(item);
    });

    it('model nieodczytany z bazy zapisuje wszystkie pola, jak dotąd', async () => {
        const {repository, queries} = harness();
        const item: ItemModel = new ItemModel();
        item.setId(1);
        item.setTitle('nowy');

        await repository.updateOne(item as WithId<ItemModel, number>);

        expect(queries[0].sql).toBe('UPDATE public.items SET title = $1, likes = $2, status = $3, tags = $4, created_at = $5 WHERE id = $6 RETURNING *;');
    });

    it('model zwrócony przez updateOne liczy zmiany od nowego stanu', async () => {
        const {repository, queries} = harness();
        const item: WithId<ItemModel, number> = repository.hydrate(FULL_ROW);
        item.setTitle('nowy');

        const saved: WithId<ItemModel, number> = await repository.updateOne(item);
        await repository.updateOne(saved);

        expect(queries).toHaveLength(1);
    });

    it('migawka nie trafia do toJSON (insertOne)', () => {
        const {repository} = harness();
        const item: WithId<ItemModel, number> = repository.hydrate(FULL_ROW);

        expect(Object.keys(item.toJSON())).toEqual(['title', 'likes', 'status', 'tags', 'created_at']);
    });

    it('updateOne z klientem transakcji wykonuje UPDATE na tym kliencie, nie na puli', async () => {
        const poolQuery = jest.fn();
        const clientQuery = jest.fn(async () => ({
            rows: [{id: 1, title: 'nowy', likes: 7, status: 'published', tags: ['a'], created_at: new Date(0)}],
        }));
        const repository = new ItemRepository({query: poolQuery} as unknown as PgClient);
        const item: WithId<ItemModel, number> = repository.hydrate(FULL_ROW);
        item.setTitle('nowy');

        await repository.updateOne(item, {query: clientQuery} as unknown as PoolClient);

        expect(clientQuery).toHaveBeenCalledWith(
            'UPDATE public.items SET title = $1 WHERE id = $2 RETURNING *;',
            ['nowy', 1],
        );
        expect(poolQuery).not.toHaveBeenCalled();
    });
});

class ConfigurableItemRepository extends PostgresRepository<ItemModel> {
    public constructor(db: PgClient, table: string, schema: string) {
        super(db, ItemModel, table, schema);
    }
}

describe('PostgresRepository - SQL identifier validation', () => {
    const db = {query: jest.fn()} as unknown as PgClient;

    it.each([
        ['schema', 'public; DROP TABLE users', 'items'],
        ['table', 'public', 'items; DROP TABLE users'],
        ['schema', 'public schema', 'items'],
        ['table', 'public', 'items-table'],
    ])('rejects an invalid %s identifier "%s.%s"', (kind: string, schema: string, table: string): void => {
        expect(() => new ConfigurableItemRepository(db, table, schema)).toThrow(
            new RegExp(`Invalid ${kind} identifier`),
        );
    });

    it('getOneByField rejects an invalid column name before querying', async (): Promise<void> => {
        const {repository, queries} = harness();

        await expect(repository.getOneByField('id = id OR 1=1', 1))
            .rejects.toThrow(/Invalid field identifier/);
        expect(queries).toHaveLength(0);
    });

    it('getManyByField rejects an invalid column name before querying', async (): Promise<void> => {
        const {repository, queries} = harness();

        await expect(repository.getManyByField('id; DROP TABLE items', 1))
            .rejects.toThrow(/Invalid field identifier/);
        expect(queries).toHaveLength(0);
    });

    it('deleteByField rejects an invalid column name before querying', async (): Promise<void> => {
        const {repository, queries} = harness();

        await expect(repository.deleteByField('id" OR "1"="1', 1))
            .rejects.toThrow(/Invalid field identifier/);
        expect(queries).toHaveLength(0);
    });

    it('allows uppercase letters, digits and $ in identifiers', async (): Promise<void> => {
        const dbQuery = jest.fn(async () => ({rows: []}));
        const repository = new ConfigurableItemRepository(
            {query: dbQuery} as unknown as PgClient,
            'Items$Archive2',
            'Public',
        );

        await expect(repository.deleteByField('ItemId$', 1)).resolves.toBeDefined();
        expect(dbQuery).toHaveBeenCalledWith('DELETE FROM Public.Items$Archive2 WHERE ItemId$ = $1;', [1]);
    });
});
