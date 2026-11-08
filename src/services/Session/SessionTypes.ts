/** What the application puts into the access token for a user. */
export interface SessionIdentity {
    /** JWT `sub`; also exposed as `metadata.username`. */
    subject: string;
    role: string | null;
    locale: string;
    /** Extra claims the application shows on every page (avatar...). `userId`/`username` are set by the framework. */
    metadata: Record<string, unknown>;
}

/**
 * Application side of the session: who the user is and whether they may hold a session at all.
 * `null` = refuse (no account, blocked) - the refresh token is then treated as dead.
 */
export interface SessionIdentityProvider {
    identify(userId: number): Promise<SessionIdentity | null>;
}

export interface RefreshTokenRecord {
    userId: number;
    tokenHash: string;
    expiresAt: Date | null;
    revokedAt: Date | null;
}

export interface NewRefreshToken {
    userId: number;
    tokenHash: string;
    ipAddress: string;
    userAgent: string;
    expiresAt: Date;
}

/** Durable storage of refresh tokens (hashes only) - the source of truth for revocation. */
export interface RefreshTokenStore {
    find(tokenHash: string): Promise<RefreshTokenRecord | null>;
    insert(token: NewRefreshToken): Promise<void>;
    touch(tokenHash: string): Promise<void>;
    revoke(tokenHash: string): Promise<void>;
    revokeAllForUser(userId: number): Promise<void>;
}

export interface SessionCookieConfig {
    accessName: string;
    refreshName: string;
    /** 'lax' lets the session survive entering the site from an external link; GET routes must then have no side effects. */
    sameSite: 'lax' | 'strict';
    secure: boolean;
    path: string;
}

export interface SessionConfig {
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
    cookies: SessionCookieConfig;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
    accessTtlSeconds: 60 * 60,
    refreshTtlSeconds: 30 * 24 * 60 * 60,
    cookies: {
        accessName: 'accessToken',
        refreshName: 'refreshToken',
        sameSite: 'lax',
        secure: true,
        path: '/',
    },
};
