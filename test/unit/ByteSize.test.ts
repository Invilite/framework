import {ByteSize} from "../../src/utils/ByteSize";

describe('ByteSize.format', () => {
    it('keeps the report format (raw bytes, one decimal, dot)', () => {
        expect(ByteSize.format(999)).toBe('999 B');
        expect(ByteSize.format(1536)).toBe('1.5 KB');
        expect(ByteSize.format(1.5 * 1024 * 1024)).toBe('1.5 MB');
    });

    it('keeps the settings format (two decimals)', () => {
        expect(ByteSize.format(999, {decimals: 2})).toBe('999 B');
        expect(ByteSize.format(1536, {decimals: 2})).toBe('1.50 KB');
        expect(ByteSize.format(1.5 * 1024 * 1024, {decimals: 2})).toBe('1.50 MB');
    });

    it('keeps the upload format (fixed MB, whole numbers without decimals)', () => {
        const options = {unit: 'MB' as const, decimals: 1, integerWithoutDecimals: true};

        expect(ByteSize.format(50 * 1024 * 1024, options)).toBe('50 MB');
        expect(ByteSize.format(1.5 * 1024 * 1024, options)).toBe('1.5 MB');
        expect(ByteSize.format(1.25 * 1024 * 1024, options)).toBe('1.3 MB');
    });
});
