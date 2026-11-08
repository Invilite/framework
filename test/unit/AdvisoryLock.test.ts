import {AdvisoryLock} from "../../src/infrastructure/Database/AdvisoryLock";

describe('AdvisoryLock', () => {
    it('takes a transaction-scoped lock with a hashed text key', async () => {
        const client = {query: jest.fn().mockResolvedValue({rows: []})};

        await AdvisoryLock.xact(client as any, 7303, '123');

        expect(client.query).toHaveBeenCalledWith(
            'SELECT pg_advisory_xact_lock($1::int, hashtext($2::text));',
            [7303, '123'],
        );
    });

    it('locks, runs, unlocks and releases the session client', async () => {
        const client = {query: jest.fn().mockResolvedValue({rows: []}), release: jest.fn()};
        const db = {getClient: jest.fn().mockResolvedValue(client)};
        const calls: string[] = [];

        const result: string = await AdvisoryLock.withSession(db, 7301, 55, async (): Promise<string> => {
            calls.push('work');
            return 'done';
        });

        expect(result).toBe('done');
        expect(calls).toEqual(['work']);
        expect(client.query.mock.calls.map((call: any[]) => call[0])).toEqual([
            'SELECT pg_advisory_lock($1::int, $2::int);',
            'SELECT pg_advisory_unlock($1::int, $2::int);',
        ]);
        expect(client.query.mock.calls[0][1]).toEqual([7301, 55]);
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('unlocks and releases when the work throws', async () => {
        const client = {query: jest.fn().mockResolvedValue({rows: []}), release: jest.fn()};
        const db = {getClient: jest.fn().mockResolvedValue(client)};
        const failure: Error = new Error('boom');

        await expect(AdvisoryLock.withSession(db, 7401, 7, async (): Promise<void> => {
            throw failure;
        })).rejects.toBe(failure);

        expect(client.query).toHaveBeenLastCalledWith(
            'SELECT pg_advisory_unlock($1::int, $2::int);',
            [7401, 7],
        );
        expect(client.release).toHaveBeenCalledTimes(1);
    });
});
