import {createHash} from "crypto";
import {AwsClient} from "aws4fetch";

export interface S3ClientConfig {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
}

export interface S3ObjectInfo {
    size: number;
    contentType?: string;
    lastModified?: Date;
}

export interface S3CompletedPart {
    partNumber: number;
    etag: string;
}

export type FetchLike = (request: Request) => Promise<Response>;

const REQUEST_TIMEOUT_MS: number = 30_000;

/** Failure reported by S3 itself, carrying enough context to map it to a StorageError. */
export class S3Error extends Error {
    public constructor(
        message: string,
        public readonly method: string,
        public readonly key: string,
        public readonly status: number,
        public readonly s3Code: string,
    ) {
        super(message);
        this.name = 'S3Error';
    }
}

/**
 * The minimal S3 protocol shared by Garage, Cloudflare R2 and Bunny: path-style URLs, SigV4 in the header and only
 * the eight operations the Storage contract needs. Request bodies are always buffers, so the payload hash is signed.
 */
export default class S3Client {
    private readonly endpoint: string;
    private readonly bucket: string;
    private readonly aws: AwsClient;
    private readonly fetchImpl: FetchLike;

    public constructor(config: S3ClientConfig, fetchImpl: FetchLike = globalThis.fetch) {
        this.endpoint = config.endpoint.replace(/\/+$/, '');
        this.bucket = config.bucket;
        this.aws = new AwsClient({
            accessKeyId: config.accessKey,
            secretAccessKey: config.secretKey,
            service: 's3',
            region: config.region,
        });
        this.fetchImpl = fetchImpl;
    }

    public async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
        const response: Response = await this.send('PUT', key, {
            headers: {'Content-Type': contentType},
            body: body as unknown as BodyInit,
        }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
        await this.ensureSuccess('PUT', key, response);
        await response.body?.cancel();
    }

    /** Returns the raw response for 2xx and 416; a missing object becomes S3Error with status 404. */
    public async getObject(key: string, range?: {offset: number, length: number}): Promise<Response> {
        const headers: Record<string, string> = {};
        if (range) {
            headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
        }

        // Only the wait for headers is bounded; once the body streams, a slow reader is not aborted mid-file.
        const controller: AbortController = new AbortController();
        const timer: NodeJS.Timeout = setTimeout((): void => controller.abort(), REQUEST_TIMEOUT_MS);
        timer.unref();
        let response: Response;
        try {
            response = await this.send('GET', key, {headers}, controller.signal);
        } finally {
            clearTimeout(timer);
        }

        if (response.status === 416) {
            return response;
        }
        if (!response.ok) {
            throw await this.failure('GET', key, response);
        }

        return response;
    }

    public async headObject(key: string): Promise<S3ObjectInfo | null> {
        const response: Response = await this.send('HEAD', key, {}, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
        if (response.status === 404) {
            return null;
        }
        if (!response.ok) {
            throw await this.failure('HEAD', key, response);
        }

        const lastModified: Date | undefined = S3Client.parseDate(response.headers.get('last-modified'));

        return {
            size: Number(response.headers.get('content-length') ?? 0),
            contentType: response.headers.get('content-type') ?? undefined,
            lastModified,
        };
    }

    /** Deleting a missing object is a success, matching the Storage contract. */
    public async deleteObject(key: string): Promise<void> {
        const response: Response = await this.send('DELETE', key, {}, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
        if (!response.ok && response.status !== 404) {
            throw await this.failure('DELETE', key, response);
        }
        await response.body?.cancel();
    }

    public async createMultipartUpload(key: string, contentType: string): Promise<string> {
        const response: Response = await this.send('POST', key, {
            headers: {'Content-Type': contentType},
        }, AbortSignal.timeout(REQUEST_TIMEOUT_MS), '?uploads');
        const body: Response = await this.ensureSuccess('POST', key, response);
        const xml: string = await body.text();
        const uploadId: string | undefined = S3Client.tag(xml, 'UploadId');
        if (!uploadId) {
            throw new S3Error(
                S3Client.describe('POST', key, response.status, 'MalformedResponse', 'no UploadId in response'),
                'POST',
                key,
                response.status,
                'MalformedResponse',
            );
        }

        return S3Client.decodeXml(uploadId);
    }

    public async uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
        const query: string = `?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
        const response: Response = await this.send('PUT', key, {
            body: body as unknown as BodyInit,
        }, AbortSignal.timeout(REQUEST_TIMEOUT_MS), query);
        await this.ensureSuccess('PUT', key, response);
        const etag: string | null = response.headers.get('etag');
        await response.body?.cancel();
        if (etag === null) {
            throw new S3Error(
                S3Client.describe('PUT', key, response.status, 'MalformedResponse', 'no ETag in response'),
                'PUT',
                key,
                response.status,
                'MalformedResponse',
            );
        }

        return etag.replace(/^"|"$/g, '');
    }

    public async completeMultipartUpload(key: string, uploadId: string, parts: S3CompletedPart[]): Promise<void> {
        const xml: string = [
            '<CompleteMultipartUpload>',
            ...parts.map((part: S3CompletedPart): string => [
                '<Part>',
                `<PartNumber>${part.partNumber}</PartNumber>`,
                `<ETag>&quot;${S3Client.escapeXml(part.etag)}&quot;</ETag>`,
                '</Part>',
            ].join('')),
            '</CompleteMultipartUpload>',
        ].join('');
        const query: string = `?uploadId=${encodeURIComponent(uploadId)}`;
        const response: Response = await this.send('POST', key, {
            headers: {'Content-Type': 'application/xml'},
            body: Buffer.from(xml) as unknown as BodyInit,
        }, AbortSignal.timeout(REQUEST_TIMEOUT_MS), query);
        const text: string = await response.text();

        // S3 may answer 200 and still report a failure inside the body.
        if (!response.ok || /<Error>/.test(text)) {
            const code: string = S3Client.tag(text, 'Code') ?? '';
            const message: string = S3Client.tag(text, 'Message') ?? '';
            const decodedCode: string = S3Client.decodeXml(code);
            throw new S3Error(
                S3Client.describe('POST', key, response.status, decodedCode, S3Client.decodeXml(message)),
                'POST',
                key,
                response.status,
                decodedCode,
            );
        }
    }

    public async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
        const query: string = `?uploadId=${encodeURIComponent(uploadId)}`;
        const response: Response = await this.send('DELETE', key, {}, AbortSignal.timeout(REQUEST_TIMEOUT_MS), query);
        if (!response.ok && response.status !== 404) {
            throw await this.failure('DELETE', key, response);
        }
        await response.body?.cancel();
    }

    private async send(method: string, key: string, init: RequestInit, signal: AbortSignal, query: string = ''): Promise<Response> {
        const body: Buffer = Buffer.isBuffer(init.body) ? init.body : Buffer.alloc(0);
        const headers: Headers = new Headers(init.headers);
        headers.set('X-Amz-Content-Sha256', createHash('sha256').update(body).digest('hex'));
        const request: Request = await this.aws.sign(`${this.endpoint}/${this.bucket}/${key}${query}`, {
            ...init,
            headers,
            method,
            signal,
        });

        try {
            return await this.fetchImpl(request);
        } catch (error) {
            const name: string = error instanceof Error ? error.name : '';
            if (name === 'TimeoutError' || name === 'AbortError') {
                throw new Error(`S3 ${method} "${key}" timed out after ${REQUEST_TIMEOUT_MS / 1000} s`, {cause: error});
            }
            const message: string = error instanceof Error ? error.message : String(error);
            throw new Error(`S3 ${method} "${key}" failed: ${message}`, {cause: error});
        }
    }

    private async ensureSuccess(method: string, key: string, response: Response): Promise<Response> {
        if (!response.ok) {
            throw await this.failure(method, key, response);
        }

        return response;
    }

    private async failure(method: string, key: string, response: Response): Promise<S3Error> {
        let text: string = '';
        try {
            text = await response.text();
        } catch {
            text = '';
        }
        const code: string = S3Client.decodeXml(S3Client.tag(text, 'Code') ?? '');
        const message: string = S3Client.decodeXml(S3Client.tag(text, 'Message') ?? '');

        return new S3Error(S3Client.describe(method, key, response.status, code, message), method, key, response.status, code);
    }

    private static describe(method: string, key: string, status: number, code: string, message: string): string {
        const details: string = [code || 'unknown', message].filter((part: string): boolean => part !== '').join(': ');

        return `S3 ${method} "${key}" failed with HTTP ${status} (${details})`;
    }

    private static tag(xml: string, name: string): string | undefined {
        return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
    }

    private static escapeXml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    private static decodeXml(value: string): string {
        return value
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
    }

    private static parseDate(value: string | null): Date | undefined {
        if (value === null) {
            return undefined;
        }
        const timestamp: number = Date.parse(value);

        return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
    }
}
