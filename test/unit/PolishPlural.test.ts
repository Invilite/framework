import {PolishPlural} from "../../src/utils/PolishPlural";

describe("PolishPlural.form", () => {
    it("1 -> singular", () => {
        expect(PolishPlural.form(1, "komentarz", "komentarze", "komentarzy")).toBe("komentarz");
    });

    it("2-4 -> plural24", () => {
        expect(PolishPlural.form(2, "komentarz", "komentarze", "komentarzy")).toBe("komentarze");
        expect(PolishPlural.form(3, "komentarz", "komentarze", "komentarzy")).toBe("komentarze");
        expect(PolishPlural.form(4, "komentarz", "komentarze", "komentarzy")).toBe("komentarze");
    });

    it("5+ -> plural5", () => {
        expect(PolishPlural.form(5, "komentarz", "komentarze", "komentarzy")).toBe("komentarzy");
        expect(PolishPlural.form(11, "komentarz", "komentarze", "komentarzy")).toBe("komentarzy");
    });

    it("12-14 wyjątek młodszej dziesiątki -> plural5", () => {
        expect(PolishPlural.form(12, "komentarz", "komentarze", "komentarzy")).toBe("komentarzy");
        expect(PolishPlural.form(13, "komentarz", "komentarze", "komentarzy")).toBe("komentarzy");
        expect(PolishPlural.form(14, "komentarz", "komentarze", "komentarzy")).toBe("komentarzy");
        expect(PolishPlural.form(22, "komentarz", "komentarze", "komentarzy")).toBe("komentarze");
    });

    it("0 -> plural5", () => {
        expect(PolishPlural.form(0, "komentarz", "komentarze", "komentarzy")).toBe("komentarzy");
    });

    it("dzień/dni", () => {
        expect(PolishPlural.form(1, "dzień", "dni", "dni")).toBe("dzień");
        expect(PolishPlural.form(2, "dzień", "dni", "dni")).toBe("dni");
    });
});

describe("PolishPlural.format", () => {
    it("skleja liczbę z formą", () => {
        expect(PolishPlural.format(1, "dzień", "dni", "dni")).toBe("1 dzień");
        expect(PolishPlural.format(4, "aktywne ogłoszenie", "aktywne ogłoszenia", "aktywnych ogłoszeń")).toBe("4 aktywne ogłoszenia");
        expect(PolishPlural.format(14, "aktywne ogłoszenie", "aktywne ogłoszenia", "aktywnych ogłoszeń")).toBe("14 aktywnych ogłoszeń");
    });
});
