import TokenBlacklistService, {ACCESS_TOKEN_MAX_TTL_SECONDS, TokenRevocationTransport} from "../../src/services/TokenBlacklistService";

class FakeLogger {
    public error(): void {}
    public notice(): void {}
    public debug(): void {}
    public warning(): void {}
}

class RecordingTransport implements TokenRevocationTransport {
    public published: Array<{userIds: number[]; revokedAt: Date}> = [];
    public handler: ((userIds: number[], revokedAt: Date) => void | Promise<void>) | null = null;

    public async publishRevocation(userIds: number[], revokedAt: Date): Promise<void> {
        this.published.push({userIds, revokedAt});
    }

    public async subscribeToRevocations(handler: (userIds: number[], revokedAt: Date) => void | Promise<void>): Promise<void> {
        this.handler = handler;
    }
}

const NOW: Date = new Date(Date.now());

describe("TokenBlacklistService - semantyka iat (hard requirement)", () => {
    it("token wydany PRZED rewokacją (iat <= revokedAt) jest odrzucany", async () => {
        const service: TokenBlacklistService = new TokenBlacklistService(new FakeLogger() as any, null);
        await service.revokeAllForUser(7, NOW);

        const iatBefore: number = Math.floor(new Date('2026-08-30T11:59:59.000Z').getTime() / 1000);
        const iatExact: number = Math.floor(NOW.getTime() / 1000);
        expect(service.isRevoked(7, iatBefore)).toBe(true);
        expect(service.isRevoked(7, iatExact)).toBe(true);
    });

    it("token wydany PO rewokacji (iat > revokedAt) jest WAZNY - re-login po zmianie hasła działa", async () => {
        const service: TokenBlacklistService = new TokenBlacklistService(new FakeLogger() as any, null);
        await service.revokeAllForUser(7, NOW);

        const iatAfter: number = Math.floor(NOW.getTime() / 1000) + 1;
        expect(service.isRevoked(7, iatAfter)).toBe(false);
    });

    it("porównuje sekundy, nie milisekundy (pułapka jednostek JWT iat)", async () => {
        const service: TokenBlacklistService = new TokenBlacklistService(new FakeLogger() as any, null);
        await service.revokeAllForUser(7, NOW);

        // iat w milisekundach byłby ogromny i zawsze > revokedAt - test wykrywa pomylenie jednostek.
        const iatInMilliseconds: number = Math.floor(new Date('2026-08-30T11:00:00.000Z').getTime());
        expect(service.isRevoked(7, iatInMilliseconds)).toBe(false);

        const iatInSeconds: number = Math.floor(new Date('2026-08-30T11:00:00.000Z').getTime() / 1000);
        expect(service.isRevoked(7, iatInSeconds)).toBe(true);
    });

    it("lokalna mapa aktualizowana synchronicznie PRZED publikacją transportu", async () => {
        const transport: RecordingTransport = new RecordingTransport();
        const service: TokenBlacklistService = new TokenBlacklistService(new FakeLogger() as any, transport);

        await service.revokeAllForUser(7, NOW);

        // Mapa chroni już przed publikacją (kolejność: set -> publish).
        expect(service.isRevoked(7, Math.floor(NOW.getTime() / 1000))).toBe(true);
        expect(transport.published).toHaveLength(1);
        expect(transport.published[0].userIds).toEqual([7]);
    });

    it("awaria transportu nie wywala wywołującego (lokalna rewokacja już zastosowana)", async () => {
        const transport: RecordingTransport = new RecordingTransport();
        transport.publishRevocation = async (): Promise<void> => {
            throw new Error('NATS down');
        };
        const service: TokenBlacklistService = new TokenBlacklistService(new FakeLogger() as any, transport);

        await expect(service.revokeAllForUser(7, NOW)).resolves.toBeUndefined();
        expect(service.isRevoked(7, Math.floor(NOW.getTime() / 1000))).toBe(true);
    });

    it("wpis wygasa leniwie po revokedAt + TTL tokenu (bez timerów)", async () => {
        const service: TokenBlacklistService = new TokenBlacklistService(new FakeLogger() as any, null);
        const old: Date = new Date(Date.now() - (ACCESS_TOKEN_MAX_TTL_SECONDS + 120) * 1000);
        await service.revokeAllForUser(7, old);

        // Wpis przeterminowany: pruning przy odczycie, token (nawet stary) nie jest odrzucany.
        expect(service.isRevoked(7, Math.floor(old.getTime() / 1000))).toBe(false);
    });

    it("idempotentność: wcześniejsza rewokacja wygrywa (szeroki zakres unieważnienia)", async () => {
        const service: TokenBlacklistService = new TokenBlacklistService(new FakeLogger() as any, null);
        const earlier: Date = new Date(NOW.getTime() - 60_000);
        await service.revokeAllForUser(7, NOW);
        await service.revokeAllForUser(7, earlier);

        // Token wydany między earlier a NOW nadal musi być odrzucony.
        const iatBetween: number = Math.floor(NOW.getTime() / 1000) - 30;
        expect(service.isRevoked(7, iatBetween)).toBe(true);
    });

    it("tryb transport=null działa jako pełnoprawna lokalna blacklist (single instance)", async () => {
        const service: TokenBlacklistService = new TokenBlacklistService(new FakeLogger() as any, null);
        await service.start();
        await service.revokeAllForUser(42, NOW);

        expect(service.isRevoked(42, Math.floor(NOW.getTime() / 1000))).toBe(true);
        expect(service.isRevoked(43, Math.floor(NOW.getTime() / 1000))).toBe(false);
    });

    it("start() odbiera rewokacje z transportu i aktualizuje mapę", async () => {
        const transport: RecordingTransport = new RecordingTransport();
        const service: TokenBlacklistService = new TokenBlacklistService(new FakeLogger() as any, transport);
        await service.start();

        expect(transport.handler).not.toBeNull();
        await transport.handler!([99], NOW);

        expect(service.isRevoked(99, Math.floor(NOW.getTime() / 1000))).toBe(true);
    });
});