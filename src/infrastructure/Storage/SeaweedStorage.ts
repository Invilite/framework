import {Readable} from "stream";
import AbstractStorage from "./AbstractStorage";
import SeaweedService from "../../services/SeaweedService";
import StorageError from "../../errors/ApplicationError/StorageError";
import {PutOptions, ReadRange, StorageStat, StorageStream, StreamingStorage} from "../../types/interfaces/Storage";
export type {StorageStream} from "../../types/interfaces/Storage";

/**
 * Storage adapter over the SeaweedFS filer. Keys use the Storage contract shape (relative path,
 * `/` separators, no leading slash) and are mapped to filer paths by prefixing a single `/`.
 *
 * `collection` and `replication` are fixed per adapter instance so every object lands in the same
 * Seaweed collection. `readHost` is the optional public read host; when it is null the adapter has
 * no public URLs and readUrl() reports StorageError('UNSUPPORTED').
 */
export default class SeaweedStorage extends AbstractStorage implements StreamingStorage {
    private static readonly INVALID_KEY_CHARACTERS: RegExp = /[\s\u0000-\u001F\u007F?#%\\"]/;

    public constructor(
        private readonly seaweed: SeaweedService,
        private readonly collection: string,
        private readonly replication: string,
        private readonly readHost: string | null,
    ) {
        super();
    }

    public async put(key: string, content: Buffer | Readable, options?: PutOptions): Promise<void> {
        const buffer: Buffer = await this.toBuffer(content);
        await this.seaweed.upload(buffer, this.filerPath(key), this.collection, this.replication, {
            contentType: options?.contentType ?? AbstractStorage.inferContentType(key),
        });
    }

    public async get(key: string, range?: ReadRange): Promise<Readable> {
        return (await this.getWithInfo(key, range)).stream;
    }

    /**
     * Same read as get(), but also returns the response size and Content-Range so a controller can
     * answer 206/200 without an extra stat round-trip. The Storage interface itself only promises
     * a Readable, so this stays an additive adapter method.
     */
    public async getWithInfo(key: string, range?: ReadRange): Promise<StorageStream> {
        return this.seaweed.stream(this.filerPath(key), range);
    }

    public async delete(key: string): Promise<void> {
        await this.seaweed.deleteIfExists(this.filerPath(key));
    }

    public async stat(key: string): Promise<StorageStat | null> {
        const stat: {size: number} | null = await this.seaweed.stat(this.filerPath(key));
        if (stat === null) {
            return null;
        }

        return {size: stat.size, contentType: AbstractStorage.inferContentType(key)};
    }

    public async readUrl(key: string): Promise<string> {
        SeaweedStorage.assertValidKey(key);
        if (this.readHost === null) {
            throw new StorageError('Public read URLs are not supported by this storage.', 'UNSUPPORTED');
        }

        return AbstractStorage.joinUrl(this.readHost, key);
    }

    private filerPath(key: string): string {
        SeaweedStorage.assertValidKey(key);
        return key.startsWith('/') ? key : `/${key}`;
    }

    private static assertValidKey(key: string): void {
        if (key.length === 0) {
            throw new StorageError('Storage key must be a non-empty string.', 'INVALID_PATH');
        }
        if (SeaweedStorage.INVALID_KEY_CHARACTERS.test(key)) {
            throw new StorageError(`Storage key "${key}" contains forbidden characters.`, 'INVALID_PATH');
        }

        const normalized: string = key.startsWith('/') ? key.slice(1) : key;
        const segments: string[] = normalized.split('/');
        if (segments.some((segment: string): boolean => segment === '' || segment === '.' || segment === '..')) {
            throw new StorageError(`Storage key "${key}" has an empty, "." or ".." path segment.`, 'INVALID_PATH');
        }
    }

    private async toBuffer(content: Buffer | Readable): Promise<Buffer> {
        if (Buffer.isBuffer(content)) {
            return content;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of content) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        return Buffer.concat(chunks);
    }
}
