import {String} from "../../src/utils/String";

describe("String.ellipsize", () => {
    it("krótszy i równy limit tekst zostaje bez zmian", () => {
        expect(String.ellipsize('abc', 5)).toBe('abc');
        expect(String.ellipsize('abcde', 5)).toBe('abcde');
        expect(String.ellipsize('', 3)).toBe('');
    });

    it("dłuższy tekst obcina po punktach kodowych i dodaje wielokropek", () => {
        expect(String.ellipsize('abcdef', 3)).toBe('abc…');
        expect(String.ellipsize('😀😀😀😀', 3)).toBe('😀😀😀…');
        expect([...String.ellipsize('😀😀😀😀', 3)]).toHaveLength(4);
    });
});
