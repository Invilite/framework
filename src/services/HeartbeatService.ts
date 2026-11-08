import {Codec, JetStreamClient, KV, Msg, NatsConnection, StringCodec} from "nats";
import {NatsError, Subscription} from "nats/lib/nats-base-client/core";
import {StorageType} from "nats/lib/jetstream/jsapi_types";
import {KvEntry} from "nats/lib/jetstream/types";
import HeartbeatTracker, {HEARTBEAT_TTL_MS} from "./HeartbeatTracker";

export default class HeartbeatService {
    private readonly jetStreamClient: JetStreamClient;
    private status: Promise<KV> | null = null;
    private readonly sc: Codec<string> = StringCodec();

    public constructor(private readonly nats: NatsConnection, private readonly namespace: string) {
        this.jetStreamClient = nats.jetstream({
            timeout: 10_000,
        });
    }

    public async beat(key: string): Promise<void> {
        const payload: Uint8Array = this.sc.encode(JSON.stringify({
            alive: true,
        }));

        await (await this.getStatus()).put(`${this.namespace}.${key}`, payload);

        this.nats.publish(`heartbeat.${this.namespace}.${key}`, payload);
    }

    public async isAlive(key: string): Promise<boolean> {
        const response: KvEntry | null = await (await this.getStatus()).get(`${this.namespace}.${key}`);

        if (!response) {
            return false;
        }

        const entry = JSON.parse(response.string());

        return entry.alive;
    }

    public async trackAll(): Promise<HeartbeatTracker> {
        const tracker: HeartbeatTracker = new HeartbeatTracker(this.nats, await this.getStatus(), this.namespace);
        await tracker.start();
        return tracker;
    }

    private getStatus(): Promise<KV> {
        if (this.status === null) {
            const pending: Promise<KV> = this.jetStreamClient.views.kv("heartbeat", {
                timeout: 5_000,
                ttl: HEARTBEAT_TTL_MS,
                storage: StorageType.Memory,
            });
            this.status = pending;
            pending.catch((): void => {
                if (this.status === pending) {
                    this.status = null;
                }
            });
        }

        return this.status;
    }

    public async watch(key: string, callback: (isAlive: boolean) => void): Promise<() => void> {
        let lastStatus: boolean = await this.isAlive(key);
        let timeout: NodeJS.Timeout | null = null;

        const restartTimeout: () => void = (): void => {
            if (timeout) {
                clearTimeout(timeout);
            }

            timeout = setTimeout((): void => {
                if (lastStatus) {
                    callback(false);
                    lastStatus = false;
                }
            }, HEARTBEAT_TTL_MS);
        }

        const notify = (error: NatsError | null, message: Msg): void => {
            if (error) {
                if (!subscription.isClosed()) {
                    subscription.unsubscribe();
                }
                return;
            }

            let payload: {alive?: unknown} | null;
            try {
                payload = JSON.parse(message.string());
            } catch {
                return;
            }

            if (payload === null || typeof payload.alive !== 'boolean') {
                return;
            }

            const alive: boolean = payload.alive;
            if (lastStatus != alive) {
                callback(alive);
            }
            lastStatus = alive;
            restartTimeout();
        }

        const subscription: Subscription = this.nats.subscribe(`heartbeat.${this.namespace}.${key}`, {
            callback: notify,
        });

        return (): void => {
            subscription.unsubscribe();
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
        }
    }
}
