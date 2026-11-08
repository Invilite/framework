import fs from "fs";
import path from "path";
import {randomUUID} from "crypto";
import {Readable, Stream} from "stream";
import AbstractStorage from "./AbstractStorage";
import StorageError from "../../errors/ApplicationError/StorageError";
import {PutOptions, ReadRange, StorageStat} from "../../types/interfaces/Storage";

/**
 * Local-filesystem storage adapter. Maps caller-generated logical keys (e.g.
 * "files/ab/cd/ef/01/hash.jpg") onto a physical tree under a configured root,
 * preserving the xx/xx/xx/xx sharded layout.
 *
 * Security: resolveKey rejects any key that escapes the root (path traversal,
 * absolute paths, null bytes). Writes are atomic (temp file + rename) so a
 * crash mid-write never leaves a partial object visible to concurrent reads.
 */
export default class FileStorage extends AbstractStorage {

    private readonly root: string;
    private readonly publicBaseUrl: string;

    public constructor(root: string, publicBaseUrl: string) {
        super();
        this.root = path.resolve(root);
        this.publicBaseUrl = publicBaseUrl;
    }

    public async put(key: string, content: Buffer | Readable, options?: PutOptions): Promise<void> {
        const fullPath: string = this.resolveKey(key);
        await fs.promises.mkdir(path.dirname(fullPath), {recursive: true});

        // Temp file is a sibling of the target so rename stays on the same
        // filesystem (atomic on POSIX). os.tmpdir() would cross filesystems and
        // rename would become EXDEV (copy + unlink, non-atomic).
        const tempPath: string = `${fullPath}.${randomUUID()}.tmp`;

        try {
            if (Buffer.isBuffer(content)) {
                await fs.promises.writeFile(tempPath, content);
            } else {
                await this.writeStream(content, tempPath);
            }
            await fs.promises.rename(tempPath, fullPath);
        } catch (error: unknown) {
            await fs.promises.unlink(tempPath).catch((): void => {});
            throw new StorageError(`Failed to write object "${key}": ${(error as NodeJS.ErrnoException).message}`, 'WRITE_FAILED');
        }
    }

    public async get(key: string, range?: ReadRange): Promise<Readable> {
        const fullPath: string = this.resolveKey(key);

        let handle: fs.promises.FileHandle;
        try {
            handle = await fs.promises.open(fullPath, 'r');
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new StorageError(`Object not found: "${key}"`, 'NOT_FOUND');
            }
            throw new StorageError(`Failed to read object "${key}": ${(error as NodeJS.ErrnoException).message}`, 'READ_FAILED');
        }

        // Use the FileHandle's own createReadStream so the handle owns the stream
        // lifecycle and is closed cleanly when the stream ends (no dangling fd).
        // Open the fd before reading so there is no TOCTOU window between a stat
        // check and the read.
        const streamOptions: { start: number; end: number; } | { start?: undefined; end?: undefined; } = range
            ? {start: range.offset, end: range.offset + range.length - 1}
            : {};

        return handle.createReadStream(streamOptions);
    }

    public async delete(key: string): Promise<void> {
        const fullPath: string = this.resolveKey(key);

        try {
            await fs.promises.unlink(fullPath);
        } catch (error: unknown) {
            // Idempotent: a missing object is a successful delete.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return;
            }
            throw new StorageError(`Failed to delete object "${key}": ${(error as NodeJS.ErrnoException).message}`, 'DELETE_FAILED');
        }
    }

    public async stat(key: string): Promise<StorageStat | null> {
        const fullPath: string = this.resolveKey(key);

        try {
            const stats: fs.Stats = await fs.promises.stat(fullPath);
            return {
                size: stats.size,
                contentType: AbstractStorage.inferContentType(key),
                lastModified: stats.mtime,
            };
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return null;
            }
            throw new StorageError(`Failed to stat object "${key}": ${(error as NodeJS.ErrnoException).message}`, 'READ_FAILED');
        }
    }

    public async readUrl(key: string): Promise<string> {
        return AbstractStorage.joinUrl(this.publicBaseUrl, key);
    }

    /**
     * Resolve a logical key to an absolute filesystem path under the root,
     * rejecting anything that would escape the root. The key must be a relative
     * path with no '..' segments, no leading '/', and no null bytes.
     */
    private resolveKey(key: string): string {
        if (typeof key !== 'string' || key.length === 0) {
            throw new StorageError('Storage key must be a non-empty string.', 'INVALID_PATH');
        }
        if (key.includes('\0')) {
            throw new StorageError('Storage key must not contain null bytes.', 'INVALID_PATH');
        }

        // Strip a single leading slash so callers that pass "/files/..." still
        // resolve correctly. A doubled leading slash ("//etc") stays absolute
        // after stripping one and is rejected by the isAbsolute check below.
        const stripped: string = key.startsWith('/') ? key.slice(1) : key;
        if (path.isAbsolute(stripped)) {
            throw new StorageError('Storage key must not be an absolute path.', 'INVALID_PATH');
        }

        const segments: string[] = stripped.split('/');
        for (const segment of segments) {
            if (segment === '..') {
                throw new StorageError('Storage key must not contain ".." segments.', 'INVALID_PATH');
            }
            if (segment.length === 0 && segments.length > 1) {
                throw new StorageError('Storage key must not contain empty segments.', 'INVALID_PATH');
            }
        }

        const full: string = path.resolve(this.root, stripped);
        if (full !== this.root && !full.startsWith(this.root + path.sep)) {
            throw new StorageError('Storage key resolves outside the storage root.', 'INVALID_PATH');
        }

        return full;
    }

    private writeStream(source: Readable, tempPath: string): Promise<void> {
        return new Promise<void>((resolve, reject): void => {
            const destination: fs.WriteStream = fs.createWriteStream(tempPath);
            Stream.pipeline(source, destination, (error: NodeJS.ErrnoException | null): void => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }
}