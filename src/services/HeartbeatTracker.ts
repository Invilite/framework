import {KV, KvEntry, Msg, NatsConnection} from "nats";
import {NatsError, Subscription} from "nats/lib/nats-base-client/core";

export const HEARTBEAT_TTL_MS: number = 60_000;

interface HeartbeatPayload {
    alive?: boolean;
}

/**
 * In-memory view of all live heartbeat keys in one namespace. The KV TTL is authoritative, but expiration
 * does not produce a reliable watch event, so liveness is derived from the last heartbeat received over
 * the core NATS subject. The subscription is established before the snapshot so a beat arriving during
 * the snapshot is never overwritten by an older KV entry.
 */
export default class HeartbeatTracker {
    private readonly lastBeatAt: Map<string, number> = new Map<string, number>();
    private subscription: Subscription | null = null;
    private lastPruneAt: number = 0;
    private stopped: boolean = false;

    public constructor(
        private readonly nats: NatsConnection,
        private readonly status: KV,
        private readonly namespace: string,
    ) {
    }

    public async start(): Promise<void> {
        if (this.subscription !== null || this.stopped) {
            return;
        }

        this.subscription = this.nats.subscribe(`heartbeat.${this.namespace}.>`, {
            callback: (error: NatsError | null, message: Msg): void => {
                if (error) {
                    return;
                }
                this.apply(message.subject.slice('heartbeat.'.length), message.string());
            },
        });

        try {
            await this.snapshot();
        } catch (error) {
            this.stop();
            throw error;
        }
    }

    public isAlive(key: string): boolean {
        if (this.stopped) {
            return false;
        }

        const now: number = Date.now();
        const fullKey: string = this.fullKey(key);
        const lastBeatAt: number | undefined = this.lastBeatAt.get(fullKey);

        if (lastBeatAt === undefined) {
            return false;
        }
        if (now - lastBeatAt >= HEARTBEAT_TTL_MS) {
            this.lastBeatAt.delete(fullKey);
            return false;
        }

        this.prune(now);
        return true;
    }

    public stop(): void {
        this.stopped = true;
        this.subscription?.unsubscribe();
        this.subscription = null;
        this.lastBeatAt.clear();
    }

    private async snapshot(): Promise<void> {
        const keys: string[] = [];
        const iterator = await this.status.keys(`${this.namespace}.>`);
        for await (const key of iterator) {
            keys.push(key);
        }

        await Promise.all(keys.map(async (key: string): Promise<void> => {
            const entry: KvEntry | null = await this.status.get(key);
            if (entry === null || entry.operation !== 'PUT') {
                return;
            }
            this.apply(key, entry.string(), entry.created.getTime());
        }));
    }

    private apply(fullKey: string, payload: string, at: number = Date.now()): void {
        let parsed: HeartbeatPayload;
        try {
            parsed = JSON.parse(payload);
        } catch {
            return;
        }

        if (parsed.alive === false) {
            this.lastBeatAt.delete(fullKey);
            return;
        }
        if (parsed.alive !== true) {
            return;
        }

        const existing: number = this.lastBeatAt.get(fullKey) ?? 0;
        this.lastBeatAt.set(fullKey, Math.max(existing, at));
        this.prune(Date.now());
    }

    private prune(now: number): void {
        if (now - this.lastPruneAt < HEARTBEAT_TTL_MS) {
            return;
        }

        this.lastPruneAt = now;
        for (const [key, lastBeatAt] of this.lastBeatAt) {
            if (now - lastBeatAt >= HEARTBEAT_TTL_MS) {
                this.lastBeatAt.delete(key);
            }
        }
    }

    private fullKey(key: string): string {
        return `${this.namespace}.${key}`;
    }
}
