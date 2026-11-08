/** In-memory sliding-window limiter: at most `limit` units per key within `windowMs`. */
export class RequestRateLimiter {
    private readonly hits: Map<string, number[]> = new Map<string, number[]>();

    public constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly now: () => number = Date.now,
    ) {
    }

    public consume(key: string, cost: number = 1): boolean {
        const units: number = Number.isInteger(cost) && cost > 0 ? cost : 1;
        const now: number = this.now();
        const recent: number[] = (this.hits.get(key) ?? [])
            .filter((timestamp: number): boolean => now - timestamp < this.windowMs);
        if (recent.length + units > this.limit) {
            this.hits.set(key, recent);
            return false;
        }
        for (let unit: number = 0; unit < units; unit++) {
            recent.push(now);
        }
        this.hits.set(key, recent);
        return true;
    }

    /** Drops keys with no hit inside the window; long-lived limiters can call it periodically to bound memory. */
    public prune(now: number = this.now()): void {
        for (const [key, timestamps] of this.hits) {
            if (timestamps.every((timestamp: number): boolean => now - timestamp >= this.windowMs)) {
                this.hits.delete(key);
            }
        }
    }
}
