import {LoginRequiredError, NotFoundError} from "../../src/errors/ApplicationError/HttpError";
import {readRequiredAuth, RequiresAuth, unguardedMethod} from "../../src/decorators/WebServer/RequiresAuth";

class Guarded {
    public readonly seen: unknown[] = [];

    @RequiresAuth()
    public members(first: unknown, second: unknown): string {
        this.seen.push(first, second);
        return 'members';
    }

    @RequiresAuth(['admin'])
    public admins(): string {
        return 'admins';
    }

    public open(): string {
        return 'open';
    }
}

describe("@RequiresAuth metadata", () => {
    it("tells socket entry points what a method demands", () => {
        const guarded: Guarded = new Guarded();

        expect(readRequiredAuth(guarded, 'members')).toEqual({roles: null});
        expect(readRequiredAuth(guarded, 'admins')).toEqual({roles: ['admin']});
        expect(readRequiredAuth(guarded, 'open')).toBeNull();
    });

    it("gives the method without the HTTP check, which a socket calls with its own arguments", () => {
        const guarded: Guarded = new Guarded();
        const socket: object = {};

        expect(unguardedMethod(guarded, 'members').call(guarded, socket, 'request')).toBe('members');
        expect(guarded.seen).toEqual([socket, 'request']);
        expect(unguardedMethod(guarded, 'open').call(guarded)).toBe('open');
    });

    it("keeps the HTTP check for requests", () => {
        const guarded: Guarded = new Guarded();

        expect(() => guarded.members({originalUrl: '/x'}, {})).toThrow(LoginRequiredError);
        expect(() => (guarded.admins as (request: unknown) => string)({auth: {role: 'user'}})).toThrow(NotFoundError);
        expect((guarded.admins as (request: unknown) => string)({auth: {role: 'admin'}})).toBe('admins');
    });
});
