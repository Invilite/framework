import {createHash} from "crypto";
import {Readable} from "stream";
import StorageError from "../../src/errors/ApplicationError/StorageError";
import S3Storage, {PART_SIZE, S3StorageConfig} from "../../src/infrastructure/Storage/S3Storage";
import {FetchLike} from "../../src/infrastructure/Storage/S3Client";

interface RecordedRequest {
    method: string;
    url: string;
    headers: Headers;
    body: Buffer;
}

interface Recorder {
    fetch: FetchLike;
    calls: RecordedRequest[];
}

const CONFIG: S3StorageConfig = {
    endpoint: 'http://storage.local:3900',
    region: 'garage',
    bucket: 'example',
    accessKey: 'GK000000000000000000000001',
    secretKey: 'top-secret-key',
    publicUrl: 'http://cdn.local',
};

function record(handler: (request: RecordedRequest) => Response | Promise<Response>): Recorder {
    const calls: RecordedRequest[] = [];
    const fetchImpl: FetchLike = async (request: Request): Promise<Response> => {
        const call: RecordedRequest = {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: Buffer.from(await request.arrayBuffer()),
        };
        calls.push(call);

        return handler(call);
    };

    return {fetch: fetchImpl, calls};
}

function sha256(body: Buffer): string {
    return createHash('sha256').update(body).digest('hex');
}

function chunks(content: Buffer, size: number): Buffer[] {
    const result: Buffer[] = [];
    for (let offset: number = 0; offset < content.length; offset += size) {
        result.push(content.subarray(offset, Math.min(offset + size, content.length)));
    }

    return result;
}

async function readAll(stream: Readable): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of stream) {
        parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array));
    }

    return Buffer.concat(parts);
}

function multipartResponder(failPart?: number): (request: RecordedRequest) => Response {
    return (request: RecordedRequest): Response => {
        const url: URL = new URL(request.url);
        if (request.method === 'POST' && url.searchParams.has('uploads')) {
            return new Response(
                '<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>',
                {status: 200},
            );
        }
        if (request.method === 'PUT' && url.searchParams.has('partNumber')) {
            const partNumber: string = url.searchParams.get('partNumber') ?? '0';
            if (failPart !== undefined && Number(partNumber) === failPart) {
                return new Response('<Error><Code>InternalError</Code><Message>broken part</Message></Error>', {status: 500});
            }

            return new Response('', {status: 200, headers: {ETag: `"etag-${partNumber}"`}});
        }
        if (request.method === 'POST' && url.searchParams.has('uploadId')) {
            return new Response('<CompleteMultipartUploadResult/>', {status: 200});
        }
        if (request.method === 'DELETE' && url.searchParams.has('uploadId')) {
            return new Response(null, {status: 204});
        }

        return new Response('', {status: 500});
    };
}

describe("S3Storage key validation", () => {
    const invalidKeys: string[] = [
        '',
        '..',
        'Photo.JPG',
        '/articles/file.jpg',
        'articles//file.jpg',
        'articles/.hidden.jpg',
        'a/../b.jpg',
        `.${'a'.repeat(512)}`,
        `${'a'.repeat(513)}.jpg`,
    ];

    it.each(invalidKeys)("rejects %p before any request", async (key: string) => {
        const recorder: Recorder = record((): Response => new Response('', {status: 500}));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await expect(storage.put(key, Buffer.from('x'))).rejects.toMatchObject({code: 'INVALID_PATH'});
        await expect(storage.get(key)).rejects.toMatchObject({code: 'INVALID_PATH'});
        await expect(storage.stat(key)).rejects.toMatchObject({code: 'INVALID_PATH'});
        await expect(storage.delete(key)).rejects.toMatchObject({code: 'INVALID_PATH'});
        await expect(storage.readUrl(key)).rejects.toMatchObject({code: 'INVALID_PATH'});
        expect(recorder.calls).toHaveLength(0);
    });

    it.each(['file.txt', 'articles/2026/image.webp', 'storage-check/abc.txt', 'a/b/c.tar.gz', 'documents/ab/cd/abcd/file'])(
        "accepts %p",
        async (key: string) => {
            const recorder: Recorder = record((): Response => new Response('', {status: 500}));
            const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

            await expect(storage.readUrl(key)).resolves.toBe(`${CONFIG.publicUrl}/${key}`);
            expect(recorder.calls).toHaveLength(0);
        },
    );
});

describe("S3Storage writes", () => {
    it("stores content below one part with a single PUT", async () => {
        const recorder: Recorder = record((): Response => new Response('', {status: 200}));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);
        const content: Buffer = Buffer.from('hello storage');

        await storage.put('articles/hello.jpg', content);

        expect(recorder.calls).toHaveLength(1);
        expect(recorder.calls[0].method).toBe('PUT');
        expect(recorder.calls[0].url).toBe('http://storage.local:3900/example/articles/hello.jpg');
        expect(recorder.calls[0].headers.get('content-type')).toBe('image/jpeg');
        expect(recorder.calls[0].body.equals(content)).toBe(true);
    });

    it("uses the supplied content type instead of the inferred one", async () => {
        const recorder: Recorder = record((): Response => new Response('', {status: 200}));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await storage.put('articles/hello.jpg', Buffer.from('x'), {contentType: 'image/custom'});

        expect(recorder.calls[0].headers.get('content-type')).toBe('image/custom');
    });

    it("signs the payload hash of the body on every request", async () => {
        const content: Buffer = Buffer.from('hash me');
        const recorder: Recorder = record((request: RecordedRequest): Response => {
            if (request.method === 'PUT') {
                return new Response(null, {status: 200});
            }
            if (request.method === 'HEAD') {
                return new Response(null, {status: 404});
            }
            if (request.method === 'DELETE') {
                return new Response(null, {status: 204});
            }

            return new Response('', {status: 200});
        });
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await storage.put('articles/hash.jpg', content);
        await readAll(await storage.get('articles/hash.jpg'));
        await storage.stat('articles/hash.jpg');
        await storage.delete('articles/hash.jpg');

        expect(recorder.calls[0].headers.get('x-amz-content-sha256')).toBe(sha256(content));
        for (const call of recorder.calls.slice(1)) {
            expect(call.headers.get('x-amz-content-sha256')).toBe(sha256(Buffer.alloc(0)));
        }
    });

    it("stores a buffer of exactly one part with a single PUT", async () => {
        const content: Buffer = Buffer.alloc(PART_SIZE, 2);
        const recorder: Recorder = record((): Response => new Response(null, {status: 200}));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await storage.put('videos/one.mp4', content);

        expect(recorder.calls).toHaveLength(1);
        expect(recorder.calls[0].method).toBe('PUT');
        expect(recorder.calls[0].url).not.toContain('uploads');
        expect(recorder.calls[0].body.length).toBe(PART_SIZE);
    });

    it("uploads a buffer larger than one part in equal parts", async () => {
        const content: Buffer = Buffer.alloc(PART_SIZE * 2 + 5, 2);
        const recorder: Recorder = record(multipartResponder());
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await storage.put('videos/buffer.mp4', content);

        const partCalls: RecordedRequest[] = recorder.calls.filter((call: RecordedRequest): boolean => call.method === 'PUT');
        expect(partCalls.map((call: RecordedRequest): number => call.body.length)).toEqual([PART_SIZE, PART_SIZE, 5]);
    });

    it("stores an empty stream as a single empty PUT", async () => {
        const recorder: Recorder = record((): Response => new Response(null, {status: 200}));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await storage.put('articles/empty.jpg', Readable.from([], {objectMode: false}));

        expect(recorder.calls).toHaveLength(1);
        expect(recorder.calls[0].method).toBe('PUT');
        expect(recorder.calls[0].body.length).toBe(0);
    });

    it("uses a one-part multipart upload for a stream of exactly one part", async () => {
        const content: Buffer = Buffer.alloc(PART_SIZE, 4);
        const recorder: Recorder = record(multipartResponder());
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await storage.put('videos/one-part.mp4', Readable.from([content], {objectMode: false}));

        const partCalls: RecordedRequest[] = recorder.calls.filter((call: RecordedRequest): boolean => call.method === 'PUT');
        expect(partCalls.map((call: RecordedRequest): number => call.body.length)).toEqual([PART_SIZE]);
        const complete: RecordedRequest | undefined = recorder.calls.find(
            (call: RecordedRequest): boolean => call.method === 'POST' && new URL(call.url).searchParams.has('uploadId'),
        );
        expect(complete?.body.toString('utf8')).toContain('<PartNumber>1</PartNumber>');
    });

    it("splits a stream just over one part into two parts", async () => {
        const content: Buffer = Buffer.alloc(PART_SIZE + 1, 5);
        const recorder: Recorder = record(multipartResponder());
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await storage.put('videos/two-parts.mp4', Readable.from([content], {objectMode: false}));

        const partCalls: RecordedRequest[] = recorder.calls.filter((call: RecordedRequest): boolean => call.method === 'PUT');
        expect(partCalls.map((call: RecordedRequest): number => call.body.length)).toEqual([PART_SIZE, 1]);
    });

    it("uploads a stream larger than one part in equal parts and completes it", async () => {
        const content: Buffer = Buffer.alloc(PART_SIZE * 2 + 3, 7);
        const recorder: Recorder = record(multipartResponder());
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await storage.put('videos/large.mp4', Readable.from(chunks(content, 1024 * 1024), {objectMode: false}));

        const partCalls: RecordedRequest[] = recorder.calls.filter((call: RecordedRequest): boolean => call.method === 'PUT');
        expect(partCalls.map((call: RecordedRequest): number => call.body.length)).toEqual([PART_SIZE, PART_SIZE, 3]);
        expect(partCalls.every((call: RecordedRequest): boolean => call.body.equals(
            content.subarray((Number(new URL(call.url).searchParams.get('partNumber')) - 1) * PART_SIZE,
                Math.min(Number(new URL(call.url).searchParams.get('partNumber')) * PART_SIZE, content.length)),
        ))).toBe(true);
        expect(partCalls.every((call: RecordedRequest): boolean =>
            call.headers.get('x-amz-content-sha256') === sha256(call.body))).toBe(true);

        const complete: RecordedRequest | undefined = recorder.calls.find(
            (call: RecordedRequest): boolean => call.method === 'POST' && new URL(call.url).searchParams.has('uploadId'),
        );
        expect(complete).toBeDefined();
        const xml: string = complete?.body.toString('utf8') ?? '';
        expect(xml).toContain('<PartNumber>1</PartNumber>');
        expect(xml).toContain('<PartNumber>2</PartNumber>');
        expect(xml).toContain('<PartNumber>3</PartNumber>');
        expect(xml).toContain('&quot;etag-1&quot;');
        expect(xml).toContain('&quot;etag-2&quot;');
        expect(xml).toContain('&quot;etag-3&quot;');
    });

    it("aborts the multipart upload and destroys the source when a part fails", async () => {
        const content: Buffer = Buffer.alloc(PART_SIZE + 1, 1);
        const recorder: Recorder = record(multipartResponder(2));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);
        const source: Readable = Readable.from([content], {objectMode: false});

        await expect(storage.put('videos/large.mp4', source)).rejects.toMatchObject({code: 'WRITE_FAILED'});

        const abort: RecordedRequest | undefined = recorder.calls.find(
            (call: RecordedRequest): boolean => call.method === 'DELETE',
        );
        expect(abort?.url).toContain('uploadId=upload-1');
        expect(source.destroyed).toBe(true);
    });

    it("aborts and fails when the source stream errors midway", async () => {
        async function* failingSource(): AsyncGenerator<Buffer> {
            yield Buffer.alloc(PART_SIZE, 6);
            throw new Error('source failed');
        }

        const recorder: Recorder = record(multipartResponder());
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);
        const source: Readable = Readable.from(failingSource(), {objectMode: false});

        await expect(storage.put('videos/broken.mp4', source)).rejects.toMatchObject({code: 'WRITE_FAILED'});

        const abort: RecordedRequest | undefined = recorder.calls.find(
            (call: RecordedRequest): boolean => call.method === 'DELETE',
        );
        expect(abort?.url).toContain('uploadId=upload-1');
        expect(source.destroyed).toBe(true);
    });

    it("treats an Error inside a 200 CompleteMultipartUpload response as a failure", async () => {
        const content: Buffer = Buffer.alloc(PART_SIZE + 1, 1);
        const recorder: Recorder = record((request: RecordedRequest): Response => {
            if (request.method === 'POST' && new URL(request.url).searchParams.has('uploads')) {
                return new Response('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>');
            }
            if (request.method === 'PUT') {
                return new Response('', {status: 200, headers: {ETag: '"etag-1"'}});
            }

            return new Response('<Error><Code>InternalError</Code><Message>complete failed</Message></Error>', {status: 200});
        });
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        let error: unknown;
        try {
            await storage.put('videos/large.mp4', Readable.from([content]));
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('WRITE_FAILED');
        expect((error as StorageError).message).toContain('InternalError');
    });

    it("never leaks the secret key in an error message", async () => {
        const recorder: Recorder = record((): Response => new Response(
            '<Error><Code>AccessDenied</Code><Message>denied</Message></Error>',
            {status: 403},
        ));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        let message: string = '';
        try {
            await storage.put('articles/hello.jpg', Buffer.from('x'));
        } catch (error) {
            message = error instanceof Error ? error.message : '';
        }

        expect(message).toContain('403');
        expect(message).toContain('AccessDenied');
        expect(message).not.toContain(CONFIG.secretKey);
    });
});

describe("S3Storage request failures", () => {
    it("reports a timeout with method and key", async () => {
        const timeout: Error = new Error('timed out');
        timeout.name = 'TimeoutError';
        const fetchImpl: FetchLike = async (): Promise<Response> => {
            throw timeout;
        };
        const storage: S3Storage = new S3Storage(CONFIG, fetchImpl);

        await expect(storage.put('articles/hello.jpg', Buffer.from('x')))
            .rejects.toThrow('S3 PUT "articles/hello.jpg" timed out after 30 s');
    });

    it("wraps a transport error with method and key", async () => {
        const fetchImpl: FetchLike = async (): Promise<Response> => {
            throw new Error('socket closed');
        };
        const storage: S3Storage = new S3Storage(CONFIG, fetchImpl);

        await expect(storage.put('articles/hello.jpg', Buffer.from('x')))
            .rejects.toThrow('S3 PUT "articles/hello.jpg" failed: socket closed');
    });
});

describe("S3Storage reads", () => {
    it("maps a missing object to NOT_FOUND", async () => {
        const recorder: Recorder = record((): Response => new Response(
            '<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>',
            {status: 404},
        ));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await expect(storage.get('articles/missing.jpg')).rejects.toMatchObject({code: 'NOT_FOUND'});
    });

    it("returns the bytes of a successful range response", async () => {
        const recorder: Recorder = record((): Response => new Response('partial', {status: 206}));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        const content: Buffer = await readAll(await storage.get('articles/hello.jpg', {offset: 2, length: 7}));

        expect(content.toString()).toBe('partial');
        expect(recorder.calls[0].headers.get('range')).toBe('bytes=2-8');
    });

    it("returns an empty stream for 416 and sends the requested range", async () => {
        const recorder: Recorder = record((): Response => new Response('', {status: 416}));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        const stream: Readable = await storage.get('articles/hello.jpg', {offset: 100, length: 10});

        expect((await readAll(stream)).length).toBe(0);
        expect(recorder.calls[0].headers.get('range')).toBe('bytes=100-109');
    });

    it("does not call S3 for a non-positive range length", async () => {
        const recorder: Recorder = record((): Response => new Response('', {status: 500}));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        const stream: Readable = await storage.get('articles/hello.jpg', {offset: 10, length: 0});

        expect((await readAll(stream)).length).toBe(0);
        expect(recorder.calls).toHaveLength(0);
    });

    it("returns null from stat when the object is absent", async () => {
        const recorder: Recorder = record((): Response => new Response(null, {status: 404}));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await expect(storage.stat('articles/missing.jpg')).resolves.toBeNull();
    });

    it("reads size, type and date from HEAD", async () => {
        const recorder: Recorder = record((): Response => new Response(null, {
            status: 200,
            headers: {
                'Content-Length': '123',
                'Content-Type': 'image/webp',
                'Last-Modified': 'Fri, 31 Oct 2026 12:00:00 GMT',
            },
        }));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await expect(storage.stat('articles/hello.webp')).resolves.toEqual({
            size: 123,
            contentType: 'image/webp',
            lastModified: new Date('Fri, 31 Oct 2026 12:00:00 GMT'),
        });
    });

    it("treats a 404 on delete as success", async () => {
        const recorder: Recorder = record((): Response => new Response(null, {status: 404}));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await expect(storage.delete('articles/missing.jpg')).resolves.toBeUndefined();
    });

    it("builds the public URL from the configured base", async () => {
        const recorder: Recorder = record((): Response => new Response('', {status: 500}));
        const storage: S3Storage = new S3Storage(CONFIG, recorder.fetch);

        await expect(storage.readUrl('articles/hello.jpg')).resolves.toBe('http://cdn.local/articles/hello.jpg');
    });

    it("refuses public URLs for a private bucket", async () => {
        const recorder: Recorder = record((): Response => new Response('', {status: 500}));
        const storage: S3Storage = new S3Storage({...CONFIG, publicUrl: null}, recorder.fetch);

        await expect(storage.readUrl('documents/ab/cd/abcd/file')).rejects.toMatchObject({code: 'UNSUPPORTED'});
        expect(recorder.calls).toHaveLength(0);
    });
});
