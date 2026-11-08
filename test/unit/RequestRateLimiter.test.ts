import {RequestRateLimiter} from "../../src/utils/RequestRateLimiter";

describe('RequestRateLimiter', () => {
    it('refuses the (limit+1)-th hit inside the window and allows it after the window passes', () => {
        let now: number = 0;
        const limiter: RequestRateLimiter = new RequestRateLimiter(2, 1000, () => now);

        expect(limiter.consume('user')).toBe(true);
        now = 100;
        expect(limiter.consume('user')).toBe(true);
        now = 200;
        expect(limiter.consume('user')).toBe(false);
        now = 1000;
        expect(limiter.consume('user')).toBe(true);
    });

    it('consumes several units at once and refuses without using the remaining ones', () => {
        let now: number = 0;
        const limiter: RequestRateLimiter = new RequestRateLimiter(5, 1000, () => now);

        expect(limiter.consume('user', 3)).toBe(true);
        expect(limiter.consume('user', 3)).toBe(false);
        expect(limiter.consume('user', 2)).toBe(true);
        expect(limiter.consume('user', 1)).toBe(false);
        now = 1000;
        expect(limiter.consume('user', 5)).toBe(true);
    });

    it('prune drops keys whose hits all left the window', () => {
        let now: number = 0;
        const limiter: RequestRateLimiter = new RequestRateLimiter(1, 1000, () => now);
        expect(limiter.consume('old')).toBe(true);
        now = 500;
        expect(limiter.consume('fresh')).toBe(true);

        now = 1000;
        limiter.prune();

        expect(limiter.consume('old')).toBe(true);
        expect(limiter.consume('fresh')).toBe(false);
    });
});
