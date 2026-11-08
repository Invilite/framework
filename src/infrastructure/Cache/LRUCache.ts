interface CacheEntry<Value> {
    value: Value;
    bytes: number;
    expiresAt: number;
}

const defaultEstimateSize: <V>(value: V) => number = <V>(value: V): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export class LRUCache<Key, Value> {
    private readonly map: Map<Key, CacheEntry<Value>> = new Map<Key, CacheEntry<Value>>();
    private readonly pending: Map<Key, Promise<Value>> = new Map<Key, Promise<Value>>();
    private readonly estimateSize: (value: Value) => number;
    private usedBytes: number = 0;

    /** `ttlMs` (optional): an entry older than this is fetched again; without it entries live until evicted. */
    constructor(private readonly cacheSize: number, private readonly fetcher: (key: Key) => Promise<Value>, estimateSize?: (value: Value) => number, private readonly ttlMs?: number) {
        if (cacheSize <= 0) throw new RangeError('cacheSize must be greater than 0');
        if (ttlMs !== undefined && ttlMs <= 0) throw new RangeError('ttlMs must be greater than 0');
        this.estimateSize = estimateSize ?? defaultEstimateSize;
    }

    public async get(key: Key): Promise<Value> {
        const cached: CacheEntry<Value> | undefined = this.map.get(key);
        if (cached && cached.expiresAt <= Date.now()) {
            this.delete(key);
        } else if (cached) {
            this.map.delete(key);
            this.map.set(key, cached);
            return cached.value;
        }

        const inflight: Promise<Value> | undefined = this.pending.get(key);
        if (inflight) return inflight;

        const promise: Promise<Value> = this.fetcher(key).then((value: Value) => {
                const bytes: number = this.estimateSize(value);
                if (bytes <= this.cacheSize) {
                    this.evictUntilFits(bytes);
                    this.map.set(key, { value, bytes, expiresAt: this.ttlMs === undefined ? Infinity : Date.now() + this.ttlMs });
                    this.usedBytes += bytes;
                }
                return value;
            }).finally(() => this.pending.delete(key));

        this.pending.set(key, promise);
        return promise;
    }

    public delete(key: Key): void {
        const entry: CacheEntry<Value> | undefined = this.map.get(key);
        if (!entry) return;
        this.map.delete(key);
        this.usedBytes -= entry.bytes;
    }

    public clear(): void {
        this.map.clear();
        this.pending.clear();
        this.usedBytes = 0;
    }

    private evictUntilFits(incomingBytes: number): void {
        while (this.usedBytes + incomingBytes > this.cacheSize && this.map.size > 0) {
            const lruKey: Key = this.map.keys().next().value as Key;
            this.delete(lruKey);
        }
    }
}