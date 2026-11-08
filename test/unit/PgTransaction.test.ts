import PgTransaction from "../../src/infrastructure/Database/PgTransaction";

interface QueryMockResult {
    rows: never[];
    command: string;
}

function build(): {client: {query: jest.Mock; release: jest.Mock}; db: {getClient: jest.Mock}} {
    const client = {
        query: jest.fn().mockImplementation(async (sql: string): Promise<QueryMockResult> => ({
            rows: [],
            command: sql,
        })),
        release: jest.fn(),
    };
    const db = {getClient: jest.fn().mockResolvedValue(client)};
    return {client, db};
}

function statements(client: {query: jest.Mock}): string[] {
    return client.query.mock.calls.map((call: unknown[]): string => String(call[0]));
}

describe('PgTransaction', () => {
    it('commits the work result on one client and releases it', async () => {
        const {client, db} = build();

        const result: number = await new PgTransaction(db).run(async (tx): Promise<number> => {
            expect(tx).toBe(client);
            return 42;
        });

        expect(result).toBe(42);
        expect(statements(client)).toEqual(['BEGIN', 'COMMIT']);
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('throws when COMMIT reports that the transaction was rolled back', async () => {
        const {client, db} = build();
        client.query.mockImplementation(async (sql: string): Promise<QueryMockResult> => ({
            rows: [],
            command: sql === 'COMMIT' ? 'ROLLBACK' : sql,
        }));

        await expect(new PgTransaction(db).run(async (): Promise<number> => 42))
            .rejects.toThrow(/rolled back/);

        expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('rolls back, rethrows and releases when the work throws', async () => {
        const {client, db} = build();
        const failure: Error = new Error('boom');

        await expect(new PgTransaction(db).run(async (): Promise<void> => {
            throw failure;
        })).rejects.toBe(failure);

        expect(statements(client)).toEqual(['BEGIN', 'ROLLBACK']);
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('keeps the original error when ROLLBACK itself throws', async () => {
        const {client, db} = build();
        const failure: Error = new Error('work failed');
        const rollbackFailure: Error = new Error('rollback failed');
        client.query.mockImplementation(async (sql: string): Promise<QueryMockResult> => {
            if (sql === 'ROLLBACK') {
                throw rollbackFailure;
            }
            return {rows: [], command: sql};
        });

        await expect(new PgTransaction(db).run(async (): Promise<void> => {
            throw failure;
        })).rejects.toBe(failure);

        expect((failure as Error & {rollbackError?: unknown}).rollbackError).toBe(rollbackFailure);
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('does not commit when the work fails', async () => {
        const {client, db} = build();

        await expect(new PgTransaction(db).run(async (): Promise<void> => {
            throw new Error('nope');
        })).rejects.toThrow('nope');

        expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    });
});
