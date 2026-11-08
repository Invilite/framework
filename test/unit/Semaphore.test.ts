import {Semaphore} from "../../src/utils/Semaphore";

describe('Semaphore', () => {
    it('runs one task at a time when the limit is 1', async () => {
        const semaphore = new Semaphore((): number => 1);
        const order: string[] = [];
        let releaseFirst: () => void = (): void => undefined;
        const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
            releaseFirst = resolve;
        });

        const first: Promise<void> = semaphore.run(async (): Promise<void> => {
            order.push('a-start');
            await gate;
            order.push('a-end');
        });
        const second: Promise<void> = semaphore.run(async (): Promise<void> => {
            order.push('b');
        });

        await Promise.resolve();
        expect(order).toEqual(['a-start']);

        releaseFirst();
        await Promise.all([first, second]);

        expect(order).toEqual(['a-start', 'a-end', 'b']);
    });

    it('reads the limit on every acquisition', async () => {
        let limit: number = 1;
        const semaphore = new Semaphore((): number => limit);
        let releaseFirst: () => void = (): void => undefined;
        const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
            releaseFirst = resolve;
        });

        const first: Promise<void> = semaphore.run(async (): Promise<void> => {
            await gate;
        });
        await Promise.resolve();

        limit = 2;
        const second: Promise<void> = semaphore.run(async (): Promise<void> => undefined);

        releaseFirst();
        await Promise.all([first, second]);
    });

    it('releases the slot when the work throws', async () => {
        const semaphore = new Semaphore((): number => 1);

        await expect(semaphore.run(async (): Promise<void> => {
            throw new Error('boom');
        })).rejects.toThrow('boom');

        await expect(semaphore.run(async (): Promise<string> => 'ok')).resolves.toBe('ok');
    });

    it('never drops below one slot', async () => {
        const semaphore = new Semaphore((): number => 0);
        let releaseFirst: () => void = (): void => undefined;
        const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
            releaseFirst = resolve;
        });
        const order: string[] = [];

        const first: Promise<void> = semaphore.run(async (): Promise<void> => {
            order.push('a');
            await gate;
        });
        const second: Promise<void> = semaphore.run(async (): Promise<void> => {
            order.push('b');
        });
        await Promise.resolve();

        expect(order).toEqual(['a']);
        releaseFirst();
        await Promise.all([first, second]);
        expect(order).toEqual(['a', 'b']);
    });
});
