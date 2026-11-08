import {LRUCache} from "../../src/infrastructure/Cache/LRUCache";

describe('LRUCache - TTL', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('bez ttlMs wpis żyje do wyparcia', async () => {
        jest.useFakeTimers();
        const fetcher: jest.Mock = jest.fn(async (key: string): Promise<string> => `v-${key}`);
        const cache: LRUCache<string, string> = new LRUCache<string, string>(1024, fetcher);

        await cache.get('a');
        jest.advanceTimersByTime(24 * 60 * 60 * 1000);
        await cache.get('a');

        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('wpis starszy niż ttlMs jest pobierany ponownie, młodszy nie', async () => {
        jest.useFakeTimers();
        let version: number = 0;
        const fetcher: jest.Mock = jest.fn(async (): Promise<number> => ++version);
        const cache: LRUCache<string, number> = new LRUCache<string, number>(1024, fetcher, undefined, 60_000);

        expect(await cache.get('user:1')).toBe(1);
        jest.advanceTimersByTime(59_999);
        expect(await cache.get('user:1')).toBe(1);
        jest.advanceTimersByTime(1);
        expect(await cache.get('user:1')).toBe(2);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('równoległe pobrania tego samego klucza idą jednym wywołaniem', async () => {
        const fetcher: jest.Mock = jest.fn(async (): Promise<string> => 'x');
        const cache: LRUCache<string, string> = new LRUCache<string, string>(1024, fetcher, undefined, 60_000);

        await Promise.all([cache.get('k'), cache.get('k'), cache.get('k')]);

        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('ttlMs <= 0 jest odrzucane', () => {
        expect(() => new LRUCache<string, string>(1024, async () => 'x', undefined, 0)).toThrow(RangeError);
    });
});
