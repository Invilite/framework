import PostgresRepository from "../../repository/PostgresRepository";
import PgClient from "../../infrastructure/Database/PgClient";
import {RefreshTokenModel} from "../../models/RefreshTokenModel";
import {NewRefreshToken, RefreshTokenRecord, RefreshTokenStore} from "./SessionTypes";

/** `public.refresh_tokens` (the migration lives in the application). */
export default class PostgresRefreshTokenStore extends PostgresRepository<RefreshTokenModel> implements RefreshTokenStore {
    public constructor(db: PgClient) {
        super(db, RefreshTokenModel, 'refresh_tokens', 'public');
    }

    public async find(tokenHash: string): Promise<RefreshTokenRecord | null> {
        const model: RefreshTokenModel | null = await this.getOneByField('token_hash', tokenHash);
        if (!model) {
            return null;
        }

        return {
            userId: model.getUserId(),
            tokenHash: model.getTokenHash(),
            expiresAt: model.getExpiresAt(),
            revokedAt: model.getRevokedAt(),
        };
    }

    public async insert(token: NewRefreshToken): Promise<void> {
        const model: RefreshTokenModel = new RefreshTokenModel();
        model.setUserId(token.userId);
        model.setTokenHash(token.tokenHash);
        model.setIpAddress(token.ipAddress);
        model.setUserAgent(token.userAgent);
        model.setCreatedAt(new Date());
        model.setExpiresAt(token.expiresAt);
        await this.insertOne(model);
    }

    public async touch(tokenHash: string): Promise<void> {
        await this.db.query(`UPDATE public.refresh_tokens SET "last_used_at" = NOW() WHERE token_hash = $1;`, [tokenHash]);
    }

    public async revoke(tokenHash: string): Promise<void> {
        await this.db.query(`UPDATE public.refresh_tokens SET "revoked_at" = NOW() WHERE token_hash = $1 AND "revoked_at" IS NULL;`, [tokenHash]);
    }

    public async revokeAllForUser(userId: number): Promise<void> {
        await this.db.query(`UPDATE public.refresh_tokens SET "revoked_at" = NOW() WHERE user_id = $1 AND "revoked_at" IS NULL;`, [userId]);
    }
}
