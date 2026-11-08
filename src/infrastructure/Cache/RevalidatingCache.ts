type AsyncFetcher<T> = () => Promise<T>;

export default class RevalidatingCache<T> {
    private cache: T | null = null;
    private lastFetch: number = 0;
    private fetchingPromise: Promise<T> | null = null;
    /** Bumped by clear(): a fetch started before it must not store its (older) result afterwards. */
    private generation: number = 0;

    constructor(private readonly fetcher: AsyncFetcher<T>, private readonly ttl: number = 3000) {}

    public get(): Promise<T> {
        const now: number = Date.now();

        if (this.cache && now - this.lastFetch < this.ttl) {
            return Promise.resolve(this.cache);
        }

        if (this.cache) {
            this.refresh();
            return Promise.resolve(this.cache);
        }

        return this.refresh();
    }

    public refresh(): Promise<T> {
        if (this.fetchingPromise) return this.fetchingPromise;

        const generation: number = this.generation;
        const promise: Promise<T> = this.fetcher().then((data: T) => {
            if (generation === this.generation) {
                this.lastFetch = Date.now();
                this.cache = data;
            }
            return data;
        }).catch(err => {
            if (this.cache !== null) return this.cache;
            throw err;
        }).finally(() => {
            if (this.fetchingPromise === promise) {
                this.fetchingPromise = null;
            }
        });
        this.fetchingPromise = promise;

        return promise;
    }

    public clear(): void {
        this.generation += 1;
        this.cache = null;
        this.lastFetch = 0;
        this.fetchingPromise = null;
    }
}