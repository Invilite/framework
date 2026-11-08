import {String} from "../../src/utils/String";

describe("String.normalizeMultiline", () => {
    it("ciąg enterów i spacji -> jedna pusta linia (akapit zostaje)", () => {
        expect(String.normalizeMultiline('a  \n\n  b')).toBe('a\n\nb');
        expect(String.normalizeMultiline('a\n\n\n\n\n\nb')).toBe('a\n\nb');
        expect(String.normalizeMultiline('a  \n  \n  \n  b')).toBe('a\n\nb');
    });

    it("pojedynczy enter zostaje, spacje na brzegach linii znikają", () => {
        expect(String.normalizeMultiline('  pierwsza  \n   druga ')).toBe('pierwsza\ndruga');
    });

    it("więcej niż 3 spacje/taby w linii -> jedna; do 3 zostają", () => {
        expect(String.normalizeMultiline('a     b\t\t\t\tc')).toBe('a b c');
        expect(String.normalizeMultiline('a   b')).toBe('a   b');
    });

    it("CRLF i same białe znaki", () => {
        expect(String.normalizeMultiline('a\r\n\r\n\r\nb')).toBe('a\n\nb');
        expect(String.normalizeMultiline(' \n \n ')).toBe('');
        expect(String.normalizeMultiline('')).toBe('');
    });
});
