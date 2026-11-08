import {parseInt8AsSafeNumber} from "../../src/infrastructure/Database/PgTypeParsers";

describe("PgTypeParsers.parseInt8AsSafeNumber", () => {
    it("parsuje typowe id do number", () => {
        expect(parseInt8AsSafeNumber("9")).toBe(9);
        expect(parseInt8AsSafeNumber("42")).toBe(42);
        expect(parseInt8AsSafeNumber("0")).toBe(0);
    });

    it("zwraca number (nie string) - klucz Map/porównanie === działa", () => {
        const id = parseInt8AsSafeNumber("9");
        expect(typeof id).toBe("number");
        const map = new Map<number, string>([[9, "wiersz"]]);
        expect(map.get(id)).toBe("wiersz");
        expect(id === 9).toBe(true);
    });

    it("akceptuje wartość dokładnie na granicy (MAX_SAFE_INTEGER)", () => {
        const max = String(Number.MAX_SAFE_INTEGER);
        expect(parseInt8AsSafeNumber(max)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("rzuca RangeError powyżej bezpiecznego zakresu (bez cichej utraty precyzji)", () => {
        // MAX_SAFE_INTEGER + 2 = 9007199254740993 (parzyste zaokrągliłoby do ...992)
        expect(() => parseInt8AsSafeNumber("9007199254740993")).toThrow(RangeError);
        expect(() => parseInt8AsSafeNumber("9223372036854775807")).toThrow(RangeError);
    });

    it("komunikat błędu wskazuje wartość i obejście (::text)", () => {
        expect(() => parseInt8AsSafeNumber("9223372036854775807"))
            .toThrow(/9223372036854775807/);
        expect(() => parseInt8AsSafeNumber("9223372036854775807"))
            .toThrow(/text/);
    });
});
