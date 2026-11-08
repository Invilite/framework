import {Logger} from "@invilite/logger";

/**
 * Transport seam for propagating token revocations to other application
 * instances. Deliberately narrow and domain-specific (not a generic
 * publish/subscribe port) so this service never grows into a third event
 * mechanism next to EventBus/NATS. Implementations live outside this file
 * (e.g. NatsTokenRevocationTransport); passing null keeps the service fully
 * functional as a single-instance blacklist.
 */
export interface TokenRevocationTransport {
    publishRevocation(userIds: number[], revokedAt: Date): Promise<void>;
    subscribeToRevocations(handler: (userIds: number[], revokedAt: Date) => void | Promise<void>): Promise<void>;
}

/** Access tokens are issued with a 1h TTL (SessionConfig.accessTtlSeconds) - an entry can be pruned after that. */
export const ACCESS_TOKEN_MAX_TTL_SECONDS: number = 60 * 60;

/**
 * In-memory JWT blacklist keyed by userId.
 *
 * Semantics (hard requirement): a token is revoked only when it was issued at
 * or before the revocation moment (`iat <= revokedAt`). Tokens issued AFTER the
 * revocation stay valid - otherwise a user could not log back in for the whole
 * TTL window after a password change. For account deletion/blocking the new
 * login is prevented by other gates (user gone / blocked tag), so the iat
 * filter never weakens those cases.
 *
 * Units trap: JWT `iat` is in SECONDS. Compare against
 * Math.floor(revokedAt.getTime() / 1000), never against milliseconds.
 *
 * Accepted residual risk (owner decision): an instance restart within the TTL
 * window can resurrect revoked access tokens for up to 1h (the map is
 * in-memory and NATS delivery is at-most-once). Durable backstops: refresh
 * tokens are revoked in the database and the login/get-token gates re-check
 * the user state (blocked / pending-deletion tags, is_active).
 */
export default class TokenBlacklistService {
    /** userId -> revocation epoch seconds. */
    private readonly revokedUsers: Map<number, number> = new Map<number, number>();
    private subscriptionActive: boolean = false;

    public constructor(
        private readonly logger: Logger,
        private readonly transport: TokenRevocationTransport | null = null,
    ) {
    }

    public async start(): Promise<void> {
        if (!this.transport || this.subscriptionActive) {
            return;
        }

        await this.transport.subscribeToRevocations((userIds: number[], revokedAt: Date): void => {
            for (const userId of userIds) {
                this.rememberRevocation(userId, revokedAt);
            }
            this.logger.debug(`[TokenBlacklist] received revocation for ${userIds.length} user(s) from transport`);
        });
        this.subscriptionActive = true;
        this.logger.notice('[TokenBlacklist] started (transport connected)');
    }

    public stop(): void {
        // The transport owns its subscription lifecycle; nothing to tear down here.
        this.subscriptionActive = false;
    }

    /**
     * Revokes all access tokens issued up to `revokedAt` for the given users.
     * The local map is updated synchronously FIRST (this instance is protected
     * immediately, no round-trip through the transport), then the revocation is
     * broadcast. Idempotent - repeated calls only move the timestamp forward.
     */
    public async revokeAllForUser(userId: number, revokedAt: Date = new Date()): Promise<void> {
        this.rememberRevocation(userId, revokedAt);

        if (this.transport) {
            try {
                await this.transport.publishRevocation([userId], revokedAt);
            } catch (e: unknown) {
                // Local revocation already applied; a failed broadcast only delays
                // propagation to other instances - never fail the caller's flow.
                this.logger.error(`[TokenBlacklist] failed to publish revocation for user ${userId}: ${(e as {message?: string} | null)?.message || e}`);
            }
        }
    }

    /**
     * True when the token was issued at or before the stored revocation moment.
     * Lazily prunes expired entries (revokedAt + max token TTL) on read - no timers.
     */
    public isRevoked(userId: number, tokenIatSeconds: number): boolean {
        const revokedAtEpoch: number | undefined = this.revokedUsers.get(userId);
        if (revokedAtEpoch === undefined) {
            return false;
        }

        const nowEpochSeconds: number = Math.floor(Date.now() / 1000);
        if (nowEpochSeconds > revokedAtEpoch + ACCESS_TOKEN_MAX_TTL_SECONDS) {
            this.revokedUsers.delete(userId);
            return false;
        }

        return tokenIatSeconds <= revokedAtEpoch;
    }

    private rememberRevocation(userId: number, revokedAt: Date): void {
        const revokedAtEpoch: number = Math.floor(revokedAt.getTime() / 1000);
        const existing: number | undefined = this.revokedUsers.get(userId);

        // Keep the LATEST revocation: "tokens issued <= revokedAt are invalid" means a
        // later timestamp invalidates a wider range. Keeping an earlier one would
        // resurrect tokens issued between the two revocations.
        if (existing === undefined || revokedAtEpoch > existing) {
            this.revokedUsers.set(userId, revokedAtEpoch);
        }
    }
}