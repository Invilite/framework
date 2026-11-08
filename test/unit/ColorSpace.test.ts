import ColorSpace, {ciede2000, hexToLab, Lab, labToHex} from '../../src/utils/ColorSpace';

describe('ColorSpace.ciede2000', () => {
    const pairs: {first: Lab; second: Lab; expected: number}[] = [
        {first: {l: 50, a: 2.6772, b: -79.7751}, second: {l: 50, a: 0, b: -82.7485}, expected: 2.0425},
        {first: {l: 50, a: 3.1571, b: -77.2803}, second: {l: 50, a: 0, b: -82.7485}, expected: 2.8615},
        {first: {l: 50, a: 2.8361, b: -74.0200}, second: {l: 50, a: 0, b: -82.7485}, expected: 3.4412},
        {first: {l: 50, a: -1.3802, b: -84.2814}, second: {l: 50, a: 0, b: -82.7485}, expected: 1.0000},
        {first: {l: 50, a: -1.1848, b: -84.8006}, second: {l: 50, a: 0, b: -82.7485}, expected: 1.0000},
        {first: {l: 50, a: -0.9009, b: -85.5211}, second: {l: 50, a: 0, b: -82.7485}, expected: 1.0000},
        {first: {l: 50, a: 0, b: 0}, second: {l: 50, a: -1, b: 2}, expected: 2.3669},
        {first: {l: 50, a: -1, b: 2}, second: {l: 50, a: 0, b: 0}, expected: 2.3669},
    ];

    it.each(pairs)('Sharma 2005: $first vs $second', ({first, second, expected}) => {
        expect(ciede2000(first, second)).toBeCloseTo(expected, 4);
        expect(ColorSpace.ciede2000(first, second)).toBeCloseTo(expected, 4);
    });
});

describe('ColorSpace hex and Lab', () => {
    it('round-trips sRGB values', () => {
        const samples: string[] = ['#000000', '#FFFFFF', '#B5652F', '#E2C79F', '#6F7445', '#1B2A4A'];
        samples.forEach((hex: string): void => {
            expect(labToHex(hexToLab(hex))).toBe(hex);
        });
    });

    it('rejects malformed hex colours', () => {
        expect(() => hexToLab('#GGGGGG')).toThrow();
        expect(() => hexToLab('B5652F')).toThrow();
    });
});
