import AbstractModel from "./AbstractModel";

export class RefreshTokenModel extends AbstractModel {
    protected user_id: number = 0;
    protected token_hash: string = "";
    protected ip_address: string = "";
    protected user_agent: string = "";

    protected created_at: Date | null = null;
    protected expires_at: Date | null = null;
    protected last_used_at: Date | null = null;
    protected revoked_at: Date | null = null;

    protected replaced_by: number | null = null;

    public setUserId(userId: number): void {
        this.user_id = userId;
    }

    public setTokenHash(tokenHash: string): void {
        this.token_hash = tokenHash;
    }

    public setIpAddress(ipAddress: string): void {
        this.ip_address = ipAddress;
    }

    public setUserAgent(userAgent: string): void {
        this.user_agent = userAgent;
    }

    public setCreatedAt(createdAt: Date): void {
        this.created_at = createdAt;
    }

    public setExpiresAt(expiresAt: Date): void {
        this.expires_at = expiresAt;
    }

    public setLastUsedAt(lastUsedAt: Date): void {
        this.last_used_at = lastUsedAt;
    }

    public setRevokedAt(revokedAt: Date): void {
        this.revoked_at = revokedAt;
    }

    public setReplacedBy(replacedBy: number): void {
        this.replaced_by = replacedBy;
    }

    public getUserId(): number {
        return this.user_id;
    }

    public getTokenHash(): string {
        return this.token_hash;
    }

    public getIpAddress(): string {
        return this.ip_address;
    }

    public getUserAgent(): string {
        return this.user_agent;
    }

    public getCreatedAt(): Date | null {
        return this.created_at;
    }

    public getExpiresAt(): Date | null {
        return this.expires_at;
    }

    public getLastUsedAt(): Date | null {
        return this.last_used_at;
    }

    public getRevokedAt(): Date | null {
        return this.revoked_at;
    }

    public isExpired(): boolean {
        if (!this.expires_at) {
            return false;
        }

        const now: Date = new Date();
        return this.expires_at < now;
    }

    public isRevoked(): boolean {
        if (!this.revoked_at) {
            return false;
        }

        const now: Date = new Date();
        return this.revoked_at < now;
    }
}