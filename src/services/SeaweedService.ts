import axios, {AxiosError, AxiosResponse} from 'axios';
import FormData from 'form-data';
import {Readable} from 'stream';
import {sign, SignOptions} from "jsonwebtoken";
import {SecretGuard} from "../decorators/SecretGuard";
import StorageError from "../errors/ApplicationError/StorageError";

interface UploadOptions {
    contentType?: string;
    filename?: string;
}

/** A hung filer must not hang uploads, deletes or scripts - every request gives up after this long. */
const DEFAULT_TIMEOUT_MS: number = 30_000;

@SecretGuard
export default class SeaweedService {

    public constructor(
        private readonly filerUrl: string,
        private readonly filerSecret: string,
        private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    ) {}

    public async upload(
        buffer: Buffer,
        filePath: string,
        collection?: string,
        replication: string = '010',
        options: UploadOptions = {},
    ): Promise<AxiosResponse<unknown>> {
        const form: FormData = new FormData();
        const contentType: string = options.contentType || this.inferContentType(filePath);
        const filename: string = this.sanitizeFilename(options.filename || this.extractFilename(filePath));

        form.append('file', buffer, { filename, contentType });

        const token: string = this.generateJWT();
        const url: string = this.buildFilerUrl(filePath, { replication, collection });
        try {
            return await axios.post(url, form, {
                timeout: this.timeoutMs,
                headers: {
                    ...form.getHeaders(),
                    Authorization: `Bearer ${token}`
                }
            });
        } catch (error: unknown) {
            SeaweedService.throwSanitized(error);
        }
    }

    public async delete(filePath: string): Promise<AxiosResponse<unknown>> {
        const token: string = this.generateJWT();
        const url: string = this.buildFilerUrl(filePath);
        try {
            return await axios.delete(url, {
                timeout: this.timeoutMs,
                headers: {
                    Authorization: `Bearer ${token}`
                }
            });
        } catch (error: unknown) {
            SeaweedService.throwSanitized(error);
        }
    }

    public async getFileMetadata(filePath: string): Promise<unknown> {
        try {
            const url: string = this.buildFilerUrl(filePath, { metadata: true });
            const response: AxiosResponse<unknown> = await axios.get(url, {
                timeout: this.timeoutMs,
                headers: {
                    'Accept': 'application/json'
                }
            });

            return response.data;
        } catch (err: unknown) {
            console.error('Error fetching file metadata:', (err as {message?: string}).message);
            SeaweedService.throwSanitized(err);
        }
    }

    public async download(filePath: string): Promise<Buffer> {
        try {
            const response: AxiosResponse<ArrayBuffer> = await axios.get(this.buildFilerUrl(filePath), {
                responseType: 'arraybuffer',
                timeout: this.timeoutMs,
                headers: {Authorization: `Bearer ${this.generateJWT()}`},
            });
            return Buffer.from(response.data);
        } catch (error: unknown) {
            SeaweedService.throwSanitized(error);
        }
    }

    /**
     * Stream a stored file, optionally only a byte window. `size` is the Content-Length of the
     * returned response (the window length for range requests); `contentRange` is the filer's
     * Content-Range header when present. Missing files become StorageError('NOT_FOUND').
     */
    public async stream(
        filePath: string,
        range?: {offset: number; length: number},
    ): Promise<{stream: Readable; size: number; contentRange: string | null}> {
        const headers: Record<string, string> = {Authorization: `Bearer ${this.generateJWT()}`};
        if (range) {
            headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
        }

        // No `timeout`: with a stream response it becomes a socket idle timer, and backpressure from
        // a slow client would abort a healthy download. Only the wait for headers is bounded here.
        const controller: AbortController = new AbortController();
        const timer: NodeJS.Timeout = setTimeout((): void => controller.abort(), this.timeoutMs);
        timer.unref();

        try {
            const response: AxiosResponse<Readable> = await axios.get(this.buildFilerUrl(filePath), {
                responseType: 'stream',
                signal: controller.signal,
                headers,
            });
            clearTimeout(timer);

            return {
                stream: response.data,
                size: Number(response.headers['content-length'] ?? 0),
                contentRange: response.headers['content-range'] ?? null,
            };
        } catch (e: unknown) {
            clearTimeout(timer);
            if (SeaweedService.isNotFound(e)) {
                throw new StorageError(`Object not found: "${filePath}"`, 'NOT_FOUND');
            }
            SeaweedService.throwSanitized(e);
        }
    }

    /** File size via HEAD; null when the file does not exist. */
    public async stat(filePath: string): Promise<{size: number} | null> {
        try {
            const response: AxiosResponse<unknown> = await axios.head(this.buildFilerUrl(filePath), {
                timeout: this.timeoutMs,
                headers: {Authorization: `Bearer ${this.generateJWT()}`},
            });
            return {size: Number(response.headers['content-length'] ?? 0)};
        } catch (e: unknown) {
            if (SeaweedService.isNotFound(e)) {
                return null;
            }
            SeaweedService.throwSanitized(e);
        }
    }

    /** Server-side copy (filer cp.from, SeaweedFS >= 3.97) - no bytes travel through the app. */
    public async copy(fromPath: string, toPath: string): Promise<void> {
        const url: string = `${this.buildFilerUrl(toPath)}?cp.from=${encodeURIComponent(fromPath)}`;
        try {
            await axios.post(url, null, {timeout: this.timeoutMs, headers: {Authorization: `Bearer ${this.generateJWT()}`}});
        } catch (error: unknown) {
            SeaweedService.throwSanitized(error);
        }
    }

    /** Delete where a missing file counts as success (idempotent cleanup). */
    public async deleteIfExists(filePath: string): Promise<void> {
        try {
            await this.delete(filePath);
        } catch (e: unknown) {
            if (SeaweedService.isNotFound(e)) {
                return;
            }
            SeaweedService.throwSanitized(e);
        }
    }

    public buildReadUrl(filePath: string, readHost?: string): string {
        const base: string = readHost || this.filerUrl;
        return this.joinUrl(base, filePath);
    }

    private static throwSanitized(error: unknown): never {
        if (!axios.isAxiosError(error)) {
            throw error;
        }

        const axiosError: AxiosError = error;
        const sanitized: Error & {code?: string; status?: number; responseData?: unknown} = new Error(axiosError.message);
        if (axiosError.code !== undefined) {
            sanitized.code = axiosError.code;
        }
        if (axiosError.response?.status !== undefined) {
            sanitized.status = axiosError.response.status;
        }
        const responseData: unknown = axiosError.response?.data;
        if (responseData instanceof Readable) {
            responseData.destroy();
        } else if (responseData !== undefined) {
            sanitized.responseData = responseData;
        }
        throw sanitized;
    }

    private static isNotFound(error: unknown): boolean {
        const candidate: {response?: {status?: number}; status?: number} | null =
            error as {response?: {status?: number}; status?: number} | null;
        return candidate?.response?.status === 404 || candidate?.status === 404;
    }

    private sanitizeFilename(filename: string): string {
        const sanitized: string = filename.replace(/[\u0000-\u001F\u007F"\\/]/g, '_');
        return sanitized.length > 0 ? sanitized : 'file';
    }

    protected generateJWT(expiresIn: number = 60): string {
        const payload: string | Buffer | object = {};

        const options: SignOptions = {
            algorithm: 'HS256',
            expiresIn: expiresIn
        };

        return sign(payload, this.filerSecret, options);
    }

    private buildFilerUrl(
        filePath: string,
        params?: { replication?: string; collection?: string; metadata?: boolean },
    ): string {
        let url: string = this.joinUrl(this.filerUrl, filePath);
        const queryParams: string[] = [];

        if (params?.replication) {
            queryParams.push(`replication=${encodeURIComponent(params.replication)}`);
        }
        if (params?.collection) {
            queryParams.push(`collection=${encodeURIComponent(params.collection)}`);
        }
        if (params?.metadata) {
            queryParams.push('metadata=true');
        }

        if (queryParams.length > 0) {
            url += `?${queryParams.join('&')}`;
        }

        return url;
    }

    private joinUrl(base: string, filePath: string): string {
        const normalizedBase: string = base.endsWith('/') ? base.slice(0, -1) : base;
        const normalizedPath: string = filePath.startsWith('/') ? filePath : `/${filePath}`;
        return `${normalizedBase}${normalizedPath}`;
    }

    private extractFilename(filePath: string): string {
        const lastSlash: number = filePath.lastIndexOf('/');
        return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
    }

    private inferContentType(filePath: string): string {
        const ext: string = this.extractFilename(filePath).split('.').pop()?.toLowerCase() || '';
        const map: Record<string, string> = {
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            gif: 'image/gif',
            webp: 'image/webp',
            svg: 'image/svg+xml',
            pdf: 'application/pdf',
            mp4: 'video/mp4',
            webm: 'video/webm',
            avi: 'video/x-msvideo',
            mov: 'video/quicktime',
            doc: 'application/msword',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls: 'application/vnd.ms-excel',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ppt: 'application/vnd.ms-powerpoint',
            pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            txt: 'text/plain',
            zip: 'application/zip',
            json: 'application/json',
            xml: 'application/xml',
        };
        return map[ext] || 'application/octet-stream';
    }
}
