import {Readable} from "stream";

/**
 * Optional metadata supplied with put(). contentType lets the adapter persist
 * the MIME type when the backend supports it (e.g. HTTP filer headers); when
 * omitted, the adapter infers it from the key extension.
 */
export interface PutOptions {
    contentType?: string;
}

/**
 * Resolved, in-bounds byte window. Both fields are absolute and non-negative.
 * The HTTP layer (Range header parsing) computes this; the adapter only
 * extracts the requested bytes. This keeps Range semantics out of storage.
 */
export interface ReadRange {
    offset: number;
    length: number;
}

/**
 * Object metadata returned by stat(). contentType and lastModified are optional
 * because not every backend stores them (a local filesystem has mtime but no
 * authoritative content-type; a filer has both). Callers fall back to
 * extension-based inference when contentType is absent.
 */
export interface StorageStat {
    size: number;
    contentType?: string;
    lastModified?: Date;
}

export interface StorageStream {
    stream: Readable;
    size: number;
    contentRange: string | null;
}

/**
 * Pluggable file storage contract. Backends (local filesystem, SeaweedFS filer,
 * S3) implement this interface; the composition root registers the chosen
 * one under the 'Storage' key in the ServiceContainer.
 *
 * Key semantics:
 * - `key` is a caller-generated logical path with `/` separators and no leading
 *   `/`. Storage does NOT generate keys.
 * - `put` is idempotent (overwrites an existing object).
 * - `get` throws StorageError('NOT_FOUND') when the key is absent.
 * - `stat` returns null when the key is absent (existence query, not an error).
 * - `delete` is idempotent (missing object is a success).
 * - `readUrl` is async so presigned-URL backends (S3) can be added without a
 *   breaking interface change later.
 */
export default interface Storage {
    put(key: string, content: Buffer | Readable, options?: PutOptions): Promise<void>;
    /**
     * Read object content as a stream. When `range` is provided, only the
     * requested byte window is returned. The caller MUST validate `range`
     * against `stat()` first (e.g. via RangeParser): an out-of-bounds range
     * yields an empty stream, not an error. Throws StorageError('NOT_FOUND')
     * when the key is absent.
     */
    get(key: string, range?: ReadRange): Promise<Readable>;
    delete(key: string): Promise<void>;
    stat(key: string): Promise<StorageStat | null>;
    readUrl(key: string): Promise<string>;
}

export interface StreamingStorage extends Storage {
    getWithInfo(key: string, range?: ReadRange): Promise<StorageStream>;
}