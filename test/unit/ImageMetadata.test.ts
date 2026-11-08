import sharp from "sharp";
import {ImageMetadata} from "../../src/utils/ImageMetadata";

async function jpeg(overrides: {withExif?: boolean} = {}): Promise<Buffer> {
    const base: Buffer = await sharp({
        create: {width: 40, height: 30, channels: 3, background: {r: 10, g: 20, b: 30}},
    }).jpeg().toBuffer();

    if (!overrides.withExif) {
        return base;
    }

    return sharp(base).withExif({
        IFD0: {Make: 'Cam\u0000\u0000', Model: 'CameraModelX'},
        IFD3: {
            GPSLatitudeRef: 'N',
            GPSLatitude: '51/1 30/1 3230/100',
            GPSLongitudeRef: 'E',
            GPSLongitude: '0/1 7/1 4366/100',
        },
    }).jpeg().toBuffer();
}

/** sharp truncates a NUL passed to withExif at encode time; inject one into the written field instead. */
function injectNulIntoModel(buffer: Buffer): Buffer {
    const copy: Buffer = Buffer.from(buffer);
    const index: number = copy.indexOf(Buffer.from('CameraModelX'));
    expect(index).toBeGreaterThan(-1);
    copy[index + 6] = 0;
    return copy;
}

describe('ImageMetadata.readExif', () => {
    it('zwraca EXIF z GPS, a NUL z pola tekstowego jest usunięty', async (): Promise<void> => {
        const buffer: Buffer = injectNulIntoModel(await jpeg({withExif: true}));

        const exif: Record<string, unknown> | null = await ImageMetadata.readExif(buffer);

        expect(exif).not.toBeNull();
        expect(exif!.Make).toBe('Cam');
        expect(exif!.Model).toBe('CameraodelX');
        expect(exif!.GPSLatitudeRef).toBe('N');
        expect(exif!.GPSLatitude).toEqual([51, 30, 32.3]);
        expect(exif!.GPSLongitude).toEqual([0, 7, 43.66]);
        expect(exif!.latitude).toBeCloseTo(51.50897, 4);
        expect(exif!.longitude).toBeCloseTo(0.12879, 4);
    });

    it('wynik jest bezpieczny dla jsonb: bez NUL i bez samotnych surogatów', async (): Promise<void> => {
        const exif: Record<string, unknown> | null = await ImageMetadata.readExif(
            injectNulIntoModel(await jpeg({withExif: true})),
        );

        const serialized: string = JSON.stringify(exif);
        expect(serialized).not.toContain('\\u0000');
        expect(serialized).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    });

    it('plik bez EXIF → null', async (): Promise<void> => {
        await expect(ImageMetadata.readExif(await jpeg())).resolves.toBeNull();
    });
});

describe('ImageMetadata.readMetadata', () => {
    it('zwraca wymiary, ale bez surowych exif/icc/iptc/xmp/xmpAsString', async (): Promise<void> => {
        const metadata: Record<string, unknown> = await ImageMetadata.readMetadata(await jpeg({withExif: true}));

        expect(metadata.width).toBe(40);
        expect(metadata.height).toBe(30);
        expect(metadata.format).toBe('jpeg');
        expect(metadata).not.toHaveProperty('exif');
        expect(metadata).not.toHaveProperty('icc');
        expect(metadata).not.toHaveProperty('iptc');
        expect(metadata).not.toHaveProperty('xmp');
        expect(metadata).not.toHaveProperty('xmpAsString');
        expect(JSON.stringify(metadata)).not.toContain('\\u0000');
    });
});
