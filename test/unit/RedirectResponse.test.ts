import {RedirectResponse} from "../../src/models/response/RedirectResponse";

describe("RedirectResponse (sentinel dla @Render - redirect 3xx)", () => {
    it("domyślny status to 301", () => {
        const r = new RedirectResponse({location: '/u/alice/photo/2415'});
        expect(r.statusCode).toBe(301);
        expect(r.location).toBe('/u/alice/photo/2415');
    });

    it("akceptuje jawne 3xx (302, 303, 307, 308)", () => {
        for (const code of [300, 301, 302, 303, 307, 308]) {
            const r = new RedirectResponse({location: '/x', statusCode: code});
            expect(r.statusCode).toBe(code);
        }
    });

    it("pusty location → RangeError", () => {
        expect(() => new RedirectResponse({location: ''})).toThrow(RangeError);
        expect(() => new RedirectResponse({location: '   '})).toThrow(RangeError);
    });

    it("non-3xx status → RangeError", () => {
        for (const code of [200, 204, 400, 404, 500]) {
            expect(() => new RedirectResponse({location: '/x', statusCode: code})).toThrow(RangeError);
        }
    });

    it("304 i 305 → RangeError (nie redirect)", () => {
        expect(() => new RedirectResponse({location: '/x', statusCode: 304})).toThrow(RangeError);
        expect(() => new RedirectResponse({location: '/x', statusCode: 305})).toThrow(RangeError);
    });
});