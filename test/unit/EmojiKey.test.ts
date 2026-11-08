import {EmojiKey} from "../../src/utils/EmojiKey";

describe("EmojiKey.fromChars", () => {
    it("usuwa selektor wariantu fe0f", () => {
        expect(EmojiKey.fromChars("❤️")).toBe("2764");
        expect(EmojiKey.fromChars("❤")).toBe("2764");
        expect(EmojiKey.fromChars("#️⃣")).toBe("23-20e3");
    });

    it("zachowuje ZWJ i modyfikator odcienia", () => {
        expect(EmojiKey.fromChars("🧜🏼‍♀️")).toBe("1f9dc-1f3fc-200d-2640");
        expect(EmojiKey.fromChars("👍🏾")).toBe("1f44d-1f3fe");
    });

    it("składa flagi z regionalnych wskaźników", () => {
        expect(EmojiKey.fromChars("🇵🇱")).toBe("1f1f5-1f1f1");
    });
});

describe("EmojiKey.fromNotoFile", () => {
    it("czyta klucz z nazwy pliku Noto", () => {
        expect(EmojiKey.fromNotoFile("emoji_u1f9dc_1f3fc_200d_2640.png")).toBe("1f9dc-1f3fc-200d-2640");
        expect(EmojiKey.fromNotoFile("emoji_u1f44d.png")).toBe("1f44d");
        expect(EmojiKey.fromNotoFile("emoji_u1f1e6_1f1e8.svg")).toBe("1f1e6-1f1e8");
    });

    it("normalizuje wiodące zera i usuwa fe0f", () => {
        expect(EmojiKey.fromNotoFile("emoji_u0023_20e3.png")).toBe("23-20e3");
        expect(EmojiKey.fromNotoFile("emoji_u2764_fe0f.png")).toBe("2764");
    });

    it("odrzuca nazwy spoza wzorca", () => {
        expect(EmojiKey.fromNotoFile("emoji_u.png")).toBeNull();
        expect(EmojiKey.fromNotoFile("emoji_uzzzz.png")).toBeNull();
        expect(EmojiKey.fromNotoFile("emoji_u1f44d.jpg")).toBeNull();
        expect(EmojiKey.fromNotoFile("1f44d.png")).toBeNull();
    });
});

describe("EmojiKey.toChars", () => {
    it("zwraca znaki bez fe0f", () => {
        expect(EmojiKey.toChars("2764")).toBe("❤");
        expect(EmojiKey.toChars("23-20e3")).toBe("#⃣");
        expect(EmojiKey.toChars("1f9dc-1f3fc-200d-2640")).toBe("🧜🏼‍♀");
    });

    it("jest odwracalne przez fromChars", () => {
        for (const key of ["2764", "1f44d", "1f9dc-1f3fc-200d-2640", "1f1f5-1f1f1", "23-20e3"]) {
            expect(EmojiKey.fromChars(EmojiKey.toChars(key))).toBe(key);
        }
    });

    it("odrzuca nieprawidłowy klucz", () => {
        expect(EmojiKey.toChars("")).toBe("");
        expect(() => EmojiKey.toChars("1f44d-zz")).toThrow();
        expect(() => EmojiKey.toChars("110000")).toThrow();
    });
});

describe("EmojiKey.withTone", () => {
    const bases: Set<string> = new Set(["1f44d", "1f9d1", "1f91d"]);

    it("zamienia każdy odcień na domyślny", () => {
        const available: Set<string> = new Set(["1f44d", "1f44d-1f3fc"]);
        expect(EmojiKey.withTone("1f44d", "1f3fc", available, bases)).toBe("1f44d-1f3fc");
        expect(EmojiKey.withTone("1f44d-1f3fb", "1f3fc", available, bases)).toBe("1f44d-1f3fc");
        expect(EmojiKey.withTone("1f44d-1f3fe", "1f3fc", available, bases)).toBe("1f44d-1f3fc");
    });

    it("wraca do bazy, gdy nie ma pliku z odcieniem", () => {
        const available: Set<string> = new Set(["1f44d"]);
        expect(EmojiKey.withTone("1f44d", "1f3fc", available, bases)).toBe("1f44d");
        expect(EmojiKey.withTone("1f44d-1f3fe", "1f3fc", available, bases)).toBe("1f44d");
    });

    it("zwraca wejście, gdy brak pliku bazy i odcienia", () => {
        expect(EmojiKey.withTone("1f44d-1f3fe", "1f3fc", new Set(), bases)).toBe("1f44d-1f3fe");
    });

    it("wieloosobowa sekwencja dostaje wspólny odcień", () => {
        const available: Set<string> = new Set([
            "1f9d1-200d-1f91d-200d-1f9d1",
            "1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3fc",
        ]);
        expect(EmojiKey.withTone("1f9d1-200d-1f91d-200d-1f9d1", "1f3fc", available, bases))
            .toBe("1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3fc");
        expect(EmojiKey.withTone("1f9d1-1f3fe-200d-1f91d-200d-1f9d1-1f3fb", "1f3fc", available, bases))
            .toBe("1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3fc");
    });

    it("wieloosobowa sekwencja bez pliku z odcieniem zostaje bazowa", () => {
        const available: Set<string> = new Set(["1f9d1-200d-1f91d-200d-1f9d1"]);
        expect(EmojiKey.withTone("1f9d1-200d-1f91d-200d-1f9d1", "1f3fc", available, bases))
            .toBe("1f9d1-200d-1f91d-200d-1f9d1");
    });
});
