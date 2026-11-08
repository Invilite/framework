import {createHash, timingSafeEqual} from 'node:crypto';

const VERIFIER_PATTERN: RegExp = /^[A-Za-z0-9\-._~]{43,128}$/;
const S256_CHALLENGE_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;

export class Pkce {
    public static verifyS256(verifier: string, challenge: string): boolean {
        if (!VERIFIER_PATTERN.test(verifier) || !Pkce.isValidChallenge(challenge)) {
            return false;
        }

        const expected: Buffer = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'), 'ascii');
        const provided: Buffer = Buffer.from(challenge, 'ascii');

        return expected.length === provided.length && timingSafeEqual(expected, provided);
    }

    public static isValidChallenge(challenge: string): boolean {
        return S256_CHALLENGE_PATTERN.test(challenge);
    }
}
