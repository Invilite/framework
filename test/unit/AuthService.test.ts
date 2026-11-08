import {JwtPayload} from "jsonwebtoken";
import {AuthService} from "../../src/services/AuthService";

const ISSUER: string = 'https://example.com';
const MCP_AUDIENCE: string = 'https://example.com/mcp';

function createAuthService(): AuthService {
    return new AuthService('HS256', 'unit-test-secret', 'unit-test-secret', ISSUER);
}

describe('AuthService audience', () => {
    let authService: AuthService;

    beforeEach((): void => {
        authService = createAuthService();
    });

    it('a token created with audience [https://example.com/mcp] fails verifyToken with the default web audience', async (): Promise<void> => {
        const token: string = await authService.createToken({metadata: {username: 'alice', userId: 1}}, '1', 3600, [MCP_AUDIENCE]);

        await expect(authService.verifyToken(token)).rejects.toThrow('jwt audience invalid');
    });

    it('a token created with audience [https://example.com/mcp] verifies with that audience', async (): Promise<void> => {
        const token: string = await authService.createToken({metadata: {username: 'alice', userId: 1}}, '1', 3600, [MCP_AUDIENCE]);

        const jwt = await authService.verifyToken(token, [MCP_AUDIENCE]);
        const payload: JwtPayload = jwt.payload as JwtPayload;

        expect(payload.aud).toEqual([MCP_AUDIENCE]);
        expect(payload.sub).toBe('1');
    });
});
