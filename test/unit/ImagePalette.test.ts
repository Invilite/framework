import ImagePalette, {fromRgbPixels, PaletteColor} from '../../src/utils/ImagePalette';

function twoColourPixels(firstShare: number): Buffer {
    const pixels: Buffer = Buffer.alloc(100 * 3);
    for (let index: number = 0; index < 100; index++) {
        const first: boolean = index < firstShare * 100;
        pixels[index * 3] = first ? 200 : 20;
        pixels[index * 3 + 1] = 60;
        pixels[index * 3 + 2] = first ? 30 : 150;
    }
    return pixels;
}

describe('ImagePalette.fromRgbPixels', () => {
    it('70/30 gives two colours with shares close to 0.7 and 0.3', () => {
        const palette: PaletteColor[] = ImagePalette.fromRgbPixels(twoColourPixels(0.7), 3, 6);
        expect(palette).toHaveLength(2);
        expect(palette[0].share).toBeCloseTo(0.7, 2);
        expect(palette[1].share).toBeCloseTo(0.3, 2);
        expect(palette.reduce((sum: number, colour: PaletteColor): number => sum + colour.share, 0)).toBeCloseTo(1, 6);
    });

    it('is deterministic for the same input', () => {
        const pixels: Buffer = twoColourPixels(0.6);
        expect(fromRgbPixels(pixels, 3, 6)).toEqual(ImagePalette.fromRgbPixels(pixels, 3, 6));
    });

    it('returns no colours for empty input', () => {
        expect(ImagePalette.fromRgbPixels(Buffer.alloc(0), 3, 5)).toEqual([]);
    });
});
