import {Codec, Events, JSONCodec, Msg, NatsConnection, Status, Sub} from "nats";
import {NatsError} from "nats/lib/nats-base-client/core";
import {TokenRevocationTransport} from "./TokenBlacklistService";

/** Broadcast subject - every instance must receive revocations, so NO queue group. */
export const TOKEN_REVOCATION_SUBJECT: string = 'token.revocation';

export const REVOCATION_CONFIRM_TIMEOUT_MS: number = 5_000;

const revocationCodec: Codec<{ userIds: number[]; revokedAt: string }> = JSONCodec();

/**
 * NATS implementation of the TokenBlacklistService transport port.
 * Publishes and subscribes to `token.revocation` as a broadcast (no queue
 * group) so every application instance keeps its local blacklist in sync.
 */
export default class NatsTokenRevocationTransport implements TokenRevocationTransport {
    private subscription: Sub<Msg> | null = null;
    private reconnectsStopped: boolean = false;

    public constructor(private readonly nats: NatsConnection) {
    }

    public async publishRevocation(userIds: number[], revokedAt: Date): Promise<void> {
        this.nats.publish(TOKEN_REVOCATION_SUBJECT, revocationCodec.encode({
            userIds,
            revokedAt: revokedAt.toISOString(),
        }));
        await this.confirmDelivery();
    }

    public subscribeToReconnects(handler: () => void | Promise<void>): void {
        this.reconnectsStopped = false;
        void this.watchReconnects(handler).catch((): void => undefined);
    }

    private async watchReconnects(handler: () => void | Promise<void>): Promise<void> {
        for await (const status of this.nats.status() as AsyncIterable<Status>) {
            if (this.reconnectsStopped) {
                return;
            }
            if (status.type === Events.Reconnect) {
                await Promise.resolve().then(handler).catch((): void => undefined);
            }
        }
    }

    public async subscribeToRevocations(handler: (userIds: number[], revokedAt: Date) => void | Promise<void>): Promise<void> {
        this.subscription = this.nats.subscribe(TOKEN_REVOCATION_SUBJECT, {
            callback: (error: NatsError | null, message: Msg): void => {
                if (error) {
                    return;
                }

                try {
                    const event: { userIds: number[]; revokedAt: string } = revocationCodec.decode(message.data);
                    const revokedAt: Date = new Date(event.revokedAt);
                    // Strict typing: string ids from a malformed payload would enter the
                    // Map as string keys and silently miss isRevoked(number) lookups.
                    const userIds: number[] = Array.isArray(event.userIds)
                        ? event.userIds.filter((id: unknown): boolean => typeof id === 'number')
                        : [];
                    if (userIds.length === 0 || isNaN(revokedAt.getTime())) {
                        return;
                    }

                    void handler(userIds, revokedAt);
                } catch {
                    // Malformed payload - ignore, the blacklist is fail-open by design.
                }
            },
        });
    }

    private async confirmDelivery(): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        const timeout: Promise<never> = new Promise<never>((_resolve: (value: never) => void, reject: (reason: Error) => void): void => {
            timer = setTimeout((): void => reject(new Error(`NATS did not confirm the revocation within ${REVOCATION_CONFIRM_TIMEOUT_MS} ms`)), REVOCATION_CONFIRM_TIMEOUT_MS);
        });
        try {
            await Promise.race([this.nats.flush(), timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    public stop(): void {
        this.subscription?.unsubscribe();
        this.subscription = null;
        this.reconnectsStopped = true;
    }
}