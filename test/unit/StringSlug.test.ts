import {String} from "../../src/utils/String";

describe("String.slug", () => {
    it("transliteruje polskie znaki", () => {
        expect(String.slug("Szukam pomocy przy projekcie")).toBe("szukam-pomocy-przy-projekcie");
        expect(String.slug("Złość gęślu źdźbło ĄĆĘŁŃÓŚŹŻ")).toBe("zlosc-geslu-zdzblo-acelnoszz");
    });

    it("znaki nienumeryczne na pojedynczy separator", () => {
        expect(String.slug("Aparat: Sony A7 III!!! (nowy)")).toBe("aparat-sony-a7-iii-nowy");
    });

    it("obcina separatory z brzegów", () => {
        expect(String.slug("--Śliczny plener--")).toBe("sliczny-plener");
    });

    it("pusty wynik dla samych znaków specjalnych", () => {
        expect(String.slug("!!! ???")).toBe("");
        expect(String.slug("")).toBe("");
    });

    it("obcięcie na granicy separatora, bez wiszącego myślnika", () => {
        const long: string = "a".repeat(60) + "-" + "b".repeat(40);
        const slug: string = String.slug(long, 80);
        expect(slug.length).toBeLessThanOrEqual(80);
        expect(slug.endsWith("-")).toBe(false);
        expect(slug).toBe("a".repeat(60));
    });

    it("obcięcie bez separatora twardo do maxLength", () => {
        expect(String.slug("b".repeat(120), 80)).toBe("b".repeat(80));
    });
});

describe("String.idSlug", () => {
    it("id + slug tytułu", () => {
        expect(String.idSlug(64, "Całość poprawiona")).toBe("64-calosc-poprawiona");
    });

    it("tytuł bez znaków ASCII → samo id", () => {
        expect(String.idSlug(7, "日本語")).toBe("7");
    });
});

describe("String.parseIdSlug", () => {
    it("wyciąga id z segmentu z slugiem", () => {
        expect(String.parseIdSlug("64-calosc-poprawiona")).toBe(64);
    });

    it("akceptuje samo id", () => {
        expect(String.parseIdSlug("64")).toBe(64);
    });

    it("tylko tekst bez id → null", () => {
        expect(String.parseIdSlug("calosc-poprawiona")).toBeNull();
    });

    it("śmieci, puste, zero, ujemne → null", () => {
        expect(String.parseIdSlug("")).toBeNull();
        expect(String.parseIdSlug("abc")).toBeNull();
        expect(String.parseIdSlug("0")).toBeNull();
        expect(String.parseIdSlug("-5")).toBeNull();
        expect(String.parseIdSlug("64-")).toBe(64);
    });
});
