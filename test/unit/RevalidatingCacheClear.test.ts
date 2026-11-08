import RevalidatingCache from "../../src/infrastructure/Cache/RevalidatingCache";

describe('RevalidatingCache.clear', () => {
    it('pobranie rozpoczęte przed clear() nie zapisuje starego wyniku', async () => {
        let release: (value: string) => void = (): void => undefined;
        const fetcher: jest.Mock = jest.fn()
            .mockImplementationOnce((): Promise<string> => new Promise<string>((resolve: (value: string) => void): void => {
                release = resolve;
            }))
            .mockResolvedValueOnce('nowe');
        const cache: RevalidatingCache<string> = new RevalidatingCache<string>(fetcher, 60_000);

        const stale: Promise<string> = cache.get();
        cache.clear();
        release('stare');
        expect(await stale).toBe('stare');

        expect(await cache.get()).toBe('nowe');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('bez clear() wynik trafia do cache', async () => {
        const fetcher: jest.Mock = jest.fn().mockResolvedValue('x');
        const cache: RevalidatingCache<string> = new RevalidatingCache<string>(fetcher, 60_000);

        await cache.get();
        await cache.get();

        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});
