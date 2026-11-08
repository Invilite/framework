import {nanoid} from "nanoid";
import crypto, {createHash} from "node:crypto";
import {Algorithm, Jwt, sign, SignOptions, verify, VerifyErrors, VerifyOptions} from "jsonwebtoken";
import {SecretGuard} from "../decorators/SecretGuard";

@SecretGuard
export class AuthService {
    private readonly keyId: string;
    private readonly algorithm: Algorithm;
    private readonly secretKey: string | Buffer;
    private readonly publicKey: string | Buffer;
    private readonly issuer: string;

    public constructor(algorithm: Algorithm, secretKey: string | Buffer, publicKey: string | Buffer, issuer: string) {
        this.keyId = this.generateKeyId(publicKey);
        this.algorithm = algorithm;
        this.secretKey = secretKey;
        this.publicKey = publicKey;
        this.issuer = issuer;
    }

    public createToken(payload: object, subject: string, expiresIn: number, audience: string[] = ['api', 'web', 'mobile']): Promise<string> {
        return new Promise<string>((resolve, reject): void => {
            const signOptions: SignOptions = {
                audience,
                algorithm: this.algorithm,
                keyid: this.keyId,
                expiresIn,
                notBefore: 0,
                subject,
                issuer: this.issuer,
                jwtid: nanoid(22),
                mutatePayload: false,
                noTimestamp: false,
                encoding: 'utf8',
                allowInsecureKeySizes: false,
                allowInvalidAsymmetricKeyTypes: false,
            }

            sign(payload, this.secretKey, signOptions, (error: Error | null, encoded: string | undefined): void => {
                if (error) {
                    reject(error);
                } else if (encoded) {
                    resolve(encoded);
                } else {
                    reject(new Error('Unknown error'));
                }
            });
        });
    }

    public verifyToken(token: string, audience: string[] = ['web']): Promise<Jwt> {
        return new Promise((resolve, reject): void => {
            const verifyOptions: VerifyOptions = {
                algorithms: ["HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"],
                audience: audience as [string, ...string[]],
                clockTolerance: 30,
                complete: true,
                issuer: this.issuer,
                ignoreExpiration: false,
                ignoreNotBefore: false,
                allowInvalidAsymmetricKeyTypes: false,
            };

            verify(token, this.publicKey, verifyOptions, (error: VerifyErrors | null, decoded: any): void => {
                if (error) {
                    reject(error);
                } else if (decoded) {
                    resolve(decoded);
                } else {
                    reject(new Error('Unknown error'));
                }
            })
        });
    }

    public generateRefreshToken(): string {
        return crypto.randomBytes(64).toString("hex");
    }

    public calculateTokenHash(token: string): string {
        return crypto.createHash("sha256").update(token).digest("hex");
    }

    private generateKeyId(publicKey: string | Buffer): string {
        return createHash('sha256').update(publicKey).digest('hex').slice(6, 31);
    }
}