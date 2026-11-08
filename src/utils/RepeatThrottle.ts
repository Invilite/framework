interface RepeatState {
    lastPassedAt: number;
    suppressedCount: number;
}

/**
 * Lets the same key through at most once per window and counts what it swallowed in between - for log lines and
 * alerts that would otherwise flood. Remembers at most `maxKeys` keys, forgetting the least recently passed one.
 */
export class RepeatThrottle {
    private readonly states: Map<string, RepeatState> = new Map<string, RepeatState>();

    public constructor(
        private readonly windowMs: number,
        private readonly maxKeys: number = 1000,
        private readonly now: () => number = Date.now,
    ) {}

    /** Returns how many repeats were suppressed since the key last passed, or `null` while inside its window. */
    public claim(key: string): number | null {
        const now: number = this.now();
        const state: RepeatState | undefined = this.states.get(key);

        if (state && now - state.lastPassedAt < this.windowMs) {
            state.suppressedCount++;
            return null;
        }

        const suppressedCount: number = state?.suppressedCount ?? 0;
        this.states.delete(key);
        if (this.states.size >= this.maxKeys) {
            const oldestKey: string | undefined = this.states.keys().next().value;
            if (oldestKey !== undefined) {
                this.states.delete(oldestKey);
            }
        }
        this.states.set(key, {lastPassedAt: now, suppressedCount: 0});

        return suppressedCount;
    }

    public clear(): void {
        this.states.clear();
    }
}
