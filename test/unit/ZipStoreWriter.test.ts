import {PassThrough, Readable} from 'stream';
import {crc32} from 'zlib';
import {ZipStoreWriter} from '../../src/utils/ZipStoreWriter';
import {ZipResponse} from '../../src/utils/ZipResponse';

interface CentralEntry {
    name: string;
    crc: number;
    size: number;
    offset: number;
}

async function archive(files: {name: string; content: Buffer}[]): Promise<Buffer> {
    const output: PassThrough = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer): void => {
        chunks.push(chunk);
    });
    const writer: ZipStoreWriter = new ZipStoreWriter(output);
    for (const file of files) {
        await writer.addFile(file.name, Readable.from([file.content.subarray(0, 3), file.content.subarray(3)]), new Date(2026, 9, 26, 12, 30, 10));
    }
    await writer.finish();
    output.end();
    return Buffer.concat(chunks);
}

function centralDirectory(zip: Buffer): CentralEntry[] {
    const end: number = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    const count: number = zip.readUInt16LE(end + 10);
    let position: number = zip.readUInt32LE(end + 16);
    expect(position + zip.readUInt32LE(end + 12)).toBe(end);

    const entries: CentralEntry[] = [];
    for (let index: number = 0; index < count; index++) {
        expect(zip.readUInt32LE(position)).toBe(0x02014b50);
        const nameLength: number = zip.readUInt16LE(position + 28);
        entries.push({
            crc: zip.readUInt32LE(position + 16),
            size: zip.readUInt32LE(position + 24),
            offset: zip.readUInt32LE(position + 42),
            name: zip.subarray(position + 46, position + 46 + nameLength).toString('utf8'),
        });
        position += 46 + nameLength;
    }
    return entries;
}

describe('ZipStoreWriter', () => {
    it('writes stored entries whose central directory points at the right local data', async () => {
        const files: {name: string; content: Buffer}[] = [
            {name: 'zdjęcie-1.jpg', content: Buffer.from('pierwsze zdjęcie')},
            {name: 'IMG_2.jpg', content: Buffer.alloc(70_000, 7)},
            {name: 'pusty.jpg', content: Buffer.alloc(0)},
        ];
        const zip: Buffer = await archive(files);
        const entries: CentralEntry[] = centralDirectory(zip);

        expect(entries.map((entry: CentralEntry): string => entry.name)).toEqual(files.map((file) => file.name));
        entries.forEach((entry: CentralEntry, index: number): void => {
            const content: Buffer = files[index].content;
            expect(entry.size).toBe(content.length);
            expect(entry.crc).toBe(crc32(content) >>> 0);
            expect(zip.readUInt32LE(entry.offset)).toBe(0x04034b50);
            const nameLength: number = zip.readUInt16LE(entry.offset + 26);
            const dataStart: number = entry.offset + 30 + nameLength;
            expect(zip.subarray(dataStart, dataStart + content.length).equals(content)).toBe(true);
            expect(zip.readUInt32LE(dataStart + content.length)).toBe(0x08074b50);
        });
    });

    it('computes the same CRC32 from the table as zlib, also across chunks (Node < 22.2 fallback)', () => {
        const data: Buffer = Buffer.from('Zażółć gęślą jaźń - 123456789', 'utf8');
        expect(ZipStoreWriter.tableCrc32(Buffer.from('123456789'))).toBe(0xcbf43926);
        expect(ZipStoreWriter.tableCrc32(data)).toBe(crc32(data) >>> 0);
        expect(ZipStoreWriter.tableCrc32(data.subarray(7), ZipStoreWriter.tableCrc32(data.subarray(0, 7)))).toBe(crc32(data) >>> 0);
    });

    it('refuses entries after finish', async () => {
        const writer: ZipStoreWriter = new ZipStoreWriter(new PassThrough());
        await writer.finish();
        await expect(writer.addFile('a.jpg', Readable.from([Buffer.from('a')]))).rejects.toThrow('already finished');
    });
});

describe('ZipResponse.uniqueName', () => {
    it('strips directories and numbers repeated names regardless of case', () => {
        const used: Set<string> = new Set<string>();
        expect(ZipResponse.uniqueName('../../etc/a.jpg', used)).toBe('a.jpg');
        expect(ZipResponse.uniqueName('A.JPG', used)).toBe('A (2).JPG');
        expect(ZipResponse.uniqueName('a.jpg', used)).toBe('a (3).jpg');
        expect(ZipResponse.uniqueName('C:\\zdjecia\\b.jpg', used)).toBe('b.jpg');
        expect(ZipResponse.uniqueName('', used)).toBe('plik');
    });

    it('never yields dot names, Windows-forbidden characters or device names', () => {
        const used: Set<string> = new Set<string>();
        expect(ZipResponse.uniqueName('..', used)).toBe('plik');
        expect(ZipResponse.uniqueName('.', used)).toBe('plik (2)');
        expect(ZipResponse.uniqueName('C:evil.jpg', used)).toBe('C_evil.jpg');
        expect(ZipResponse.uniqueName('a<b>|c?.jpg', used)).toBe('a_b__c_.jpg');
        expect(ZipResponse.uniqueName('CON.jpg', used)).toBe('_CON.jpg');
        expect(ZipResponse.uniqueName('zdjęcie. ', used)).toBe('zdjęcie');
    });
});
