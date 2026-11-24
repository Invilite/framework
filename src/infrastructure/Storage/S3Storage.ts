import {randomBytes} from "crypto";
import {Readable} from "stream";
import StorageError from "../../errors/ApplicationError/StorageError";
import AbstractStorage from "./AbstractStorage";
import {PutOptions, ReadRange, StorageStat, StorageStream, StreamingStorage} from "../../types/interfaces/Storage";
import S3Client, {FetchLike, S3CompletedPart, S3Error} from "./S3Client";

export interface S3StorageConfig {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    /** Public read host (CDN or bucket website); null for private buckets served only through the application. */
    publicUrl: string | null;
}

/** Equal part size for multipart uploads; R2 requires every part but the last to have the same size. */
export const PART_SIZE: number = 8 * 1024 * 1024;

const KEY_MAX_LENGTH: number = 512;
const KEY_CHARACTERS: RegExp = /^[a-z0-9._/-]+$/;

/**
 * Storage adapter over any S3-compatible API (Cloudflare R2, Bunny Storage, Garage): path-style URLs, SigV4 and only
 * the eight operations in S3Client, so switching providers is configuration. Keys are limited to characters every
 * provider signs and encodes the same way.
 */
export default class S3Storage extends AbstractStorage implements StreamingStorage {
    private readonly publicUrl: string | null;
    private readonly client: S3Client;

    public constructor(config: S3StorageConfig, fetchImpl: FetchLike = globalThis.fetch) {
        super();
        this.publicUrl = config.publicUrl;
        this.client = new S3Client({
            endpoint: config.endpoint,
            region: config.region,
            bucket: config.bucket,
            accessKey: config.accessKey,
            secretKey: config.secretKey,
        }, fetchImpl);
    }

    public async put(key: string, content: Buffer | Readable, options?: PutOptions): Promise<void> {
        S3Storage.assertValidKey(key);
        const contentType: string = options?.contentType ?? AbstractStorage.inferContentType(key);
        try {
            if (Buffer.isBuffer(content)) {
                await this.putBuffer(key, content, contentType);
            } else {
                await this.putStream(key, content, contentType);
            }
        } catch (error) {
            throw new StorageError(S3Storage.failure(key, error), 'WRITE_FAILED');
        }
    }

    public async get(key: string, range?: ReadRange): Promise<Readable> {
        return (await this.getWithInfo(key, range)).stream;
    }

    public async getWithInfo(key: string, range?: ReadRange): Promise<StorageStream> {
        S3Storage.assertValidKey(key);
        if (range && range.length <= 0) {
            return {stream: Readable.from([]), size: 0, contentRange: null};
        }

        try {
            const response: Response = await this.client.getObject(key, range);
            if (response.status === 416 || response.body === null) {
                if (response.body !== null) {
                    await response.body.cancel();
                }

                return {stream: Readable.from([]), size: 0, contentRange: null};
            }

            return {
                stream: Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
                size: Number(response.headers.get('content-length') ?? 0),
                contentRange: response.headers.get('content-range'),
            };
        } catch (error) {
            if (error instanceof S3Error && error.status === 404) {
                throw new StorageError(`Storage object "${key}" not found`, 'NOT_FOUND');
            }
            throw new StorageError(S3Storage.failure(key, error), 'READ_FAILED');
        }
    }

    public async stat(key: string): Promise<StorageStat | null> {
        S3Storage.assertValidKey(key);
        try {
            return await this.client.headObject(key);
        } catch (error) {
            throw new StorageError(S3Storage.failure(key, error), 'READ_FAILED');
        }
    }

    public async delete(key: string): Promise<void> {
        S3Storage.assertValidKey(key);
        try {
            await this.client.deleteObject(key);
        } catch (error) {
            throw new StorageError(S3Storage.failure(key, error), 'DELETE_FAILED');
        }
    }

    public async readUrl(key: string): Promise<string> {
        S3Storage.assertValidKey(key);
        if (this.publicUrl === null) {
            throw new StorageError('Public read URLs are not supported by this storage.', 'UNSUPPORTED');
        }

        return AbstractStorage.joinUrl(this.publicUrl, key);
    }

    /** Writes and removes a probe file; called at startup so a wrong endpoint, key or bucket stops the application. */
    public async verify(): Promise<void> {
        const key: string = `storage-check/${randomBytes(16).toString('hex')}.txt`;
        try {
            await this.put(key, Buffer.from('storage check'));
        } catch (error) {
            throw new Error(`Storage check failed, cannot write "${key}": ${S3Storage.detail(error)}`);
        }
        try {
            await this.delete(key);
        } catch (error) {
            throw new Error(`Storage check failed, cannot delete "${key}": ${S3Storage.detail(error)}`);
        }
    }

    private async putBuffer(key: string, content: Buffer, contentType: string): Promise<void> {
        if (content.length <= PART_SIZE) {
            await this.client.putObject(key, content, contentType);
            return;
        }

        const uploadId: string = await this.client.createMultipartUpload(key, contentType);
        try {
            const parts: S3CompletedPart[] = [];
            let partNumber: number = 1;
            for (let offset: number = 0; offset < content.length; offset += PART_SIZE) {
                const body: Buffer = content.subarray(offset, Math.min(offset + PART_SIZE, content.length));
                const etag: string = await this.client.uploadPart(key, uploadId, partNumber, body);
                parts.push({partNumber, etag});
                partNumber++;
            }
            await this.client.completeMultipartUpload(key, uploadId, parts);
        } catch (error) {
            await this.abortQuietly(key, uploadId);
            throw error;
        }
    }

    private async putStream(key: string, stream: Readable, contentType: string): Promise<void> {
        try {
            await this.writeStream(key, stream, contentType);
        } catch (error) {
            stream.destroy();
            throw error;
        }
    }

    private async writeStream(key: string, stream: Readable, contentType: string): Promise<void> {
        const reader: PartReader = new PartReader(stream);
        const first: Buffer | null = await reader.nextPart();
        if (first === null) {
            await this.client.putObject(key, Buffer.alloc(0), contentType);
            return;
        }
        if (first.length < PART_SIZE) {
            await this.client.putObject(key, first, contentType);
            return;
        }

        const uploadId: string = await this.client.createMultipartUpload(key, contentType);
        try {
            const parts: S3CompletedPart[] = [];
            let partNumber: number = 1;
            let part: Buffer | null = first;
            while (part !== null) {
                const etag: string = await this.client.uploadPart(key, uploadId, partNumber, part);
                parts.push({partNumber, etag});
                partNumber++;
                part = await reader.nextPart();
            }
            await this.client.completeMultipartUpload(key, uploadId, parts);
        } catch (error) {
            await this.abortQuietly(key, uploadId);
            throw error;
        }
    }

    private async abortQuietly(key: string, uploadId: string): Promise<void> {
        try {
            await this.client.abortMultipartUpload(key, uploadId);
        } catch {
            // The original write error is the one the caller needs; a failed abort cannot be fixed here.
        }
    }

    private static assertValidKey(key: string): void {
        if (key.length === 0 || key.length > KEY_MAX_LENGTH) {
            throw new StorageError(`Storage key must be 1-${KEY_MAX_LENGTH} characters long`, 'INVALID_PATH');
        }
        if (!KEY_CHARACTERS.test(key)) {
            throw new StorageError(`Storage key "${key}" may contain only a-z, 0-9, ".", "_", "-" and "/"`, 'INVALID_PATH');
        }

        const segments: string[] = key.split('/');
        if (segments.some((segment: string): boolean => segment === '' || segment.startsWith('.'))) {
            throw new StorageError(`Storage key "${key}" has an empty or hidden path segment`, 'INVALID_PATH');
        }
    }

    private static failure(key: string, error: unknown): string {
        return `Storage object "${key}": ${S3Storage.detail(error)}`;
    }

    private static detail(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

/** Reads a stream into parts of exactly PART_SIZE bytes, buffering only the part being uploaded. */
class PartReader {
    private readonly iterator: AsyncIterator<unknown>;
    private chunk: Buffer | null = null;
    private offset: number = 0;

    public constructor(stream: Readable) {
        this.iterator = stream[Symbol.asyncIterator]();
    }

    public async nextPart(): Promise<Buffer | null> {
        const chunks: Buffer[] = [];
        let length: number = 0;
        while (length < PART_SIZE) {
            if (this.chunk === null || this.offset >= this.chunk.length) {
                const result: IteratorResult<unknown> = await this.iterator.next();
                if (result.done) {
                    break;
                }
                this.chunk = PartReader.toBuffer(result.value);
                this.offset = 0;
                continue;
            }

            const size: number = Math.min(PART_SIZE - length, this.chunk.length - this.offset);
            chunks.push(this.chunk.subarray(this.offset, this.offset + size));
            this.offset += size;
            length += size;
        }

        if (length === 0) {
            return null;
        }

        return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
    }

    private static toBuffer(value: unknown): Buffer {
        return Buffer.isBuffer(value) ? value : Buffer.from(value as string | Uint8Array);
    }
}
