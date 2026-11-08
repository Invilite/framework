import {NulChar} from "../../src/utils";

describe('NulChar.strip', (): void => {
    it('usuwa NUL z zagnieżdżonych stringów i kluczy (EXIF dopełniony zerami)', (): void => {
        const exif: Record<string, unknown> = {
            Make: 'Canon\u0000\u0000\u0000',
            makerNote: {Owner: 'Jan\u0000Kowalski', list: ['a\u0000', 1, null]},
            'Key\u0000': true,
        };

        const result: Record<string, unknown> = NulChar.strip(exif);

        expect(result).toEqual({
            Make: 'Canon',
            makerNote: {Owner: 'JanKowalski', list: ['a', 1, null]},
            Key: true,
        });
        expect(JSON.stringify(result)).not.toContain('\\u0000');
        expect(exif.Make).toBe('Canon\u0000\u0000\u0000');
    });

    it('usuwa samotne surogaty UTF-16 z wartości i kluczy, poprawne pary (emoji) zostawia', (): void => {
        const broken: Record<string, unknown> = {
            high: 'a\uD800b',
            low: 'c\uDC00d',
            both: 'x\uD800y\uDC00z',
            emoji: 'Foto \uD83D\uDCF7',
            'ke\uD800y': 'v\uDC00',
        };

        const result: Record<string, unknown> = NulChar.strip(broken);

        expect(result).toEqual({
            high: 'ab',
            low: 'cd',
            both: 'xyz',
            emoji: 'Foto \uD83D\uDCF7',
            key: 'v',
        });
        expect(JSON.stringify(result)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });

    it('zostawia instancje (Date, Buffer, typed arrays) nietknięte', (): void => {
        const date: Date = new Date('2026-10-14T05:41:34Z');
        const buffer: Buffer = Buffer.from([0, 1, 2]);
        const bytes: Uint8Array = new Uint8Array([0, 65]);

        const result = NulChar.strip({date, buffer, bytes});

        expect(result.date).toBe(date);
        expect(result.buffer).toBe(buffer);
        expect(result.bytes).toBe(bytes);
    });

    it('przepuszcza null/undefined/liczby (exifr zwraca undefined bez EXIF)', (): void => {
        expect(NulChar.strip(undefined)).toBeUndefined();
        expect(NulChar.strip(null)).toBeNull();
        expect(NulChar.strip(42)).toBe(42);
    });
});
