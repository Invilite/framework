import {Codec, JSONCodec, Msg, NatsConnection, Sub} from "nats";
import {NatsError} from "nats/lib/nats-base-client/core";
import {TokenRevocationTransport} from "./TokenBlacklistService";

/** Broadcast subject - every instance must receive revocations, so NO queue group. */
export const TOKEN_REVOCATION_SUBJECT: string = 'token.revocation';

const revocationCodec: Codec<{ userIds: number[]; revokedAt: string }> = JSONCodec();

/**
 * NATS implementation of the TokenBlacklistService transport port.
 * Publishes and subscribes to `token.revocation` as a broadcast (no queue
 * group) so every application instance keeps its local blacklist in sync.
 */
export default class NatsTokenRevocationTransport implements TokenRevocationTransport {
    private subscription: Sub<Msg> | null = null;

    public constructor(private readonly nats: NatsConnection) {
    }

    public async publishRevocation(userIds: number[], revokedAt: Date): Promise<void> {
        this.nats.publish(TOKEN_REVOCATION_SUBJECT, revocationCodec.encode({
            userIds,
            revokedAt: revokedAt.toISOString(),
        }));
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

    public stop(): void {
        this.subscription?.unsubscribe();
        this.subscription = null;
    }
}