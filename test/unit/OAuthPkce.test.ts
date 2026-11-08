import {Pkce} from '../../src/services/OAuth/Pkce';

const RFC_VERIFIER: string = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE: string = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('Pkce', () => {
    it('verifyS256 accepts the RFC 7636 appendix B example and rejects plain', () => {
        expect(Pkce.verifyS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
        expect(Pkce.verifyS256(RFC_VERIFIER, RFC_VERIFIER)).toBe(false);
    });

    it('verifyS256 rejects a verifier outside the RFC 7636 syntax and a malformed challenge', () => {
        expect(Pkce.verifyS256('too-short', RFC_CHALLENGE)).toBe(false);
        expect(Pkce.verifyS256(RFC_VERIFIER, RFC_CHALLENGE.slice(0, 42))).toBe(false);
        expect(Pkce.isValidChallenge(RFC_CHALLENGE)).toBe(true);
        expect(Pkce.isValidChallenge('plain')).toBe(false);
    });
});
