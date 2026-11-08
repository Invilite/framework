/**
 * In-memory concurrency gate. The limit is a function so callers can keep exposing a mutable
 * constant (tests replace it) and the current value is read on every acquisition.
 */
export class Semaphore {
    private active: number = 0;
    private readonly waiting: Array<() => void> = [];

    public constructor(private readonly limit: () => number) {}

    public async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    private async acquire(): Promise<void> {
        const limit: number = Math.max(1, this.limit());
        if (this.active < limit) {
            this.active += 1;
            return;
        }

        await new Promise<void>((resolve: () => void): void => {
            this.waiting.push(resolve);
        });
    }

    private release(): void {
        this.active -= 1;
        const next: (() => void) | undefined = this.waiting.shift();
        if (next !== undefined) {
            this.active += 1;
            next();
        }
    }
}
