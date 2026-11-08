import {Readable, Writable} from 'stream';
import zlib from 'zlib';

type Crc32 = (data: Buffer, previous: number) => number;

interface ZipEntryRecord {
    name: Buffer;
    crc: number;
    size: number;
    offset: number;
    time: number;
    date: number;
}

/**
 * Strumieniowy zapis archiwum ZIP bez kompresji (metoda STORE) - do paczek plików, które już są
 * skompresowane (JPEG). Każdy plik idzie prosto ze źródła do wyjścia: CRC i rozmiar trafiają do
 * deskryptora danych po treści (bit 3), więc nic nie jest buforowane w pamięci. Bez ZIP64: archiwum
 * i pojedynczy plik muszą być mniejsze niż 4 GiB, a plików najwyżej 65 535 - przekroczenie to błąd.
 */
export class ZipStoreWriter {
    public static readonly MAX_BYTES: number = 0xffffffff;

    public static readonly MAX_ENTRIES: number = 0xffff;

    /** Bit 3: CRC i rozmiary w deskryptorze danych; bit 11: nazwy w UTF-8. */
    private static readonly FLAGS: number = 0x0808;

    private static readonly VERSION: number = 20;

    /** `zlib.crc32` jest od Node 22.2, więc starszy Node liczy z tablicy. */
    private static readonly crc32: Crc32 = typeof (zlib as {crc32?: Crc32}).crc32 === 'function'
        ? (zlib as {crc32: Crc32}).crc32
        : ZipStoreWriter.tableCrc32;

    private static table: Uint32Array | null = null;

        private readonly entries: ZipEntryRecord[] = [];

    private offset: number = 0;

    private finished: boolean = false;

    public constructor(private readonly output: Writable) {
    }

    public async addFile(name: string, source: Readable, modified: Date = new Date()): Promise<void> {
        if (this.finished) {
            throw new Error('ZIP archive is already finished.');
        }
        if (this.entries.length >= ZipStoreWriter.MAX_ENTRIES) {
            throw new RangeError('ZIP archive cannot hold more entries without ZIP64.');
        }

        const nameBuffer: Buffer = Buffer.from(name, 'utf8');
        const {time, date}: { time: number; date: number; } = ZipStoreWriter.dosDateTime(modified);
        const offset: number = this.offset;

        const header: Buffer = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(ZipStoreWriter.VERSION, 4);
        header.writeUInt16LE(ZipStoreWriter.FLAGS, 6);
        header.writeUInt16LE(0, 8);
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(date, 12);
        header.writeUInt16LE(nameBuffer.length, 26);
        await this.write(Buffer.concat([header, nameBuffer]));

        let crc: number = 0;
        let size: number = 0;
        for await (const chunk of source) {
            const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            crc = ZipStoreWriter.crc32(buffer, crc);
            size += buffer.length;
            await this.write(buffer);
        }

        const descriptor: Buffer = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc >>> 0, 4);
        descriptor.writeUInt32LE(size, 8);
        descriptor.writeUInt32LE(size, 12);
        await this.write(descriptor);

        this.entries.push({name: nameBuffer, crc: crc >>> 0, size, offset, time, date});
    }

    /** Dopisuje katalog centralny. Wyjścia nie zamyka - robi to wywołujący. */
    public async finish(): Promise<void> {
        if (this.finished) {
            return;
        }
        this.finished = true;

        const directoryOffset: number = this.offset;
        for (const entry of this.entries) {
            const record: Buffer = Buffer.alloc(46);
            record.writeUInt32LE(0x02014b50, 0);
            record.writeUInt16LE(ZipStoreWriter.VERSION, 4);
            record.writeUInt16LE(ZipStoreWriter.VERSION, 6);
            record.writeUInt16LE(ZipStoreWriter.FLAGS, 8);
            record.writeUInt16LE(0, 10);
            record.writeUInt16LE(entry.time, 12);
            record.writeUInt16LE(entry.date, 14);
            record.writeUInt32LE(entry.crc, 16);
            record.writeUInt32LE(entry.size, 20);
            record.writeUInt32LE(entry.size, 24);
            record.writeUInt16LE(entry.name.length, 28);
            record.writeUInt32LE(entry.offset, 42);
            await this.write(Buffer.concat([record, entry.name]));
        }

        const end: Buffer = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(this.entries.length, 8);
        end.writeUInt16LE(this.entries.length, 10);
        end.writeUInt32LE(this.offset - directoryOffset, 12);
        end.writeUInt32LE(directoryOffset, 16);
        await this.write(end);
    }

    private async write(buffer: Buffer): Promise<void> {
        if (this.offset + buffer.length > ZipStoreWriter.MAX_BYTES) {
            throw new RangeError('ZIP archive exceeds 4 GiB, which needs ZIP64.');
        }
        if (this.output.destroyed) {
            throw new Error('ZIP output was closed.');
        }
        this.offset += buffer.length;
        if (!this.output.write(buffer)) {
            await new Promise<void>((resolve, reject): void => {
                const cleanup: () => void = (): void => {
                    this.output.off('drain', onDrain);
                    this.output.off('close', onClose);
                    this.output.off('error', onClose);
                };
                const onDrain: () => void = (): void => {
                    cleanup();
                    resolve();
                };
                const onClose: () => void = (): void => {
                    cleanup();
                    reject(new Error('ZIP output was closed.'));
                };
                this.output.once('drain', onDrain);
                this.output.once('close', onClose);
                this.output.once('error', onClose);
            });
        }
    }

    /** Data i czas w formacie MS-DOS (rozdzielczość 2 s, od 1980 roku), w czasie lokalnym serwera. */
    private static dosDateTime(modified: Date): {time: number; date: number} {
        const value: Date = Number.isNaN(modified.getTime()) ? new Date() : modified;
        const year: number = Math.min(Math.max(value.getFullYear(), 1980), 2107);
        return {
            time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
            date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
        };
    }

    public static tableCrc32(data: Buffer, previous: number = 0): number {
        if (ZipStoreWriter.table === null) {
            const table: Uint32Array = new Uint32Array(256);
            for (let index: number = 0; index < 256; index++) {
                let value: number = index;
                for (let bit: number = 0; bit < 8; bit++) {
                    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
                }
                table[index] = value >>> 0;
            }
            ZipStoreWriter.table = table;
        }
        const table: Uint32Array = ZipStoreWriter.table;
        let crc: number = (previous ^ 0xffffffff) >>> 0;
        for (let index: number = 0; index < data.length; index++) {
            crc = table[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }
}

export default ZipStoreWriter;
