import {Readable} from "stream";
import http from "http";
import {AddressInfo} from "net";
import express from "express";
import FormData from "form-data";
import {Upload, UploadOptions} from "../../src/decorators/WebServer/Upload";

interface Invocation {
    controllerCalled: boolean;
    status: number | null;
    body: any;
    headers: Record<string, string>;
}

function multipart(fieldName: string, content: Buffer): {body: Buffer; headers: Record<string, string>} {
    const form: FormData = new FormData();
    form.append(fieldName, content, {filename: 'upload.bin', contentType: 'application/octet-stream'});

    return {
        body: form.getBuffer(),
        headers: {...form.getHeaders(), 'content-length': String(form.getLengthSync())},
    };
}

async function invokePayload(
    decorator: MethodDecorator,
    payload: {body: Buffer; headers: Record<string, string>},
): Promise<Invocation> {
    let controllerCalled: boolean = false;
    const descriptor: any = {
        value: async function (): Promise<string> {
            controllerCalled = true;
            return 'controller-result';
        },
    };
    (decorator as any)({}, 'handler', descriptor);

    const request: any = Readable.from(payload.body);
    request.headers = payload.headers;
    request.method = 'POST';
    request.url = '/upload';

    let status: number | null = null;
    let body: any = null;
    let headersSent: boolean = false;
    let writableEnded: boolean = false;
    const headers: Record<string, string> = {};

    const response: any = {
        get headersSent(): boolean { return headersSent; },
        get writableEnded(): boolean { return writableEnded; },
        setHeader(name: string, value: string): unknown {
            headers[name.toLowerCase()] = value;

            return this;
        },
        status(code: number): any { status = code; return this; },
        json(payload: any): any { body = payload; headersSent = true; writableEnded = true; return this; },
    };

    await descriptor.value.call({}, request, response, jest.fn());

    return {controllerCalled, status, body, headers};
}

async function invoke(
    decorator: MethodDecorator,
    fieldName: string,
    content: Buffer,
): Promise<Invocation> {
    return invokePayload(decorator, multipart(fieldName, content));
}

interface HttpInvocation {
    controllerCalled: boolean;
    originalName: string | null;
    status: number;
    body: any;
}

async function invokeOverHttp(options: UploadOptions, form: FormData): Promise<HttpInvocation> {
    const app: express.Express = express();
    let controllerCalled: boolean = false;
    let originalName: string | null = null;

    class Handler {
        public async handle(request: express.Request, response: express.Response): Promise<void> {
            controllerCalled = true;
            originalName = request.file ? request.file.originalname : null;
            response.json({status: {success: true}, data: {name: originalName}});
        }
    }

    const descriptor: PropertyDescriptor = Object.getOwnPropertyDescriptor(Handler.prototype, 'handle')!;
    const decorated: PropertyDescriptor = Upload('file', options)(Handler.prototype, 'handle', descriptor)!;
    Object.defineProperty(Handler.prototype, 'handle', decorated);
    const handler: Handler = new Handler();
    app.post('/upload', (request: express.Request, response: express.Response, next: express.NextFunction): void => {
        handler.handle(request, response).catch(next);
    });

    const server: http.Server = await new Promise<http.Server>((resolve: (value: http.Server) => void): void => {
        const listening: http.Server = app.listen(0, (): void => resolve(listening));
    });
    const port: number = (server.address() as AddressInfo).port;
    const payload: Buffer = form.getBuffer();

    try {
        const response: {status: number; body: any} = await new Promise((resolve, reject): void => {
            const request: http.ClientRequest = http.request({
                host: '127.0.0.1',
                port,
                path: '/upload',
                method: 'POST',
                headers: {...form.getHeaders(), 'content-length': String(payload.length)},
            }, (incoming: http.IncomingMessage): void => {
                const chunks: Buffer[] = [];
                incoming.on('data', (chunk: Buffer): void => {
                    chunks.push(Buffer.from(chunk));
                });
                incoming.on('end', (): void => {
                    const text: string = Buffer.concat(chunks).toString('utf8');
                    resolve({status: incoming.statusCode ?? 0, body: text ? JSON.parse(text) : null});
                });
            });
            request.on('error', reject);
            request.end(payload);
        });
        return {controllerCalled, originalName, status: response.status, body: response.body};
    } finally {
        await new Promise<void>((resolve: () => void): void => {
            server.close((): void => resolve());
        });
    }
}

describe('Upload decorator', () => {
    it('z maxFileSize: plik większy niż limit → 413 JSON i metoda kontrolera nie jest wołana', async (): Promise<void> => {
        const result: Invocation = await invoke(
            Upload('file', {maxFileSize: 1024 * 1024}),
            'file',
            Buffer.alloc(1024 * 1024 + 1, 1),
        );

        expect(result.controllerCalled).toBe(false);
        expect(result.status).toBe(413);
        expect(result.body.status.success).toBe(false);
        expect(result.body.errors).toEqual([
            expect.objectContaining({details: 'LIMIT_FILE_SIZE', message: expect.stringContaining('1 MB')}),
        ]);
        expect(result.body.errors[0].message).toBe('Plik przekracza maksymalny dozwolony rozmiar (1 MB).');
        expect(result.headers['cache-control']).toBe('private, no-store');
    });

    it('z opcjami: zbyt długa nazwa pola → 400 JSON z Cache-Control no-store', async (): Promise<void> => {
        const form: FormData = new FormData();
        form.append('x'.repeat(200), 'value');

        const result: Invocation = await invokePayload(
            Upload('file', {maxFileSize: 1024 * 1024, maxFieldNameSize: 100}),
            {
                body: form.getBuffer(),
                headers: {...form.getHeaders(), 'content-length': String(form.getLengthSync())},
            },
        );

        expect(result.controllerCalled).toBe(false);
        expect(result.status).toBe(400);
        expect(result.body.errors[0].details).toBe('LIMIT_FIELD_KEY');
        expect(result.headers['cache-control']).toBe('private, no-store');
    });

    it('z maxFileSize: plik w limicie przechodzi do kontrolera', async (): Promise<void> => {
        const result: Invocation = await invoke(
            Upload('file', {maxFileSize: 1024 * 1024}),
            'file',
            Buffer.from('small'),
        );

        expect(result.controllerCalled).toBe(true);
        expect(result.status).toBeNull();
    });

    it('bez opcji zachowuje się jak dotychczas: plik trafia do request.file, brak odpowiedzi z dekoratora', async (): Promise<void> => {
        const result: Invocation = await invoke(Upload('file'), 'file', Buffer.from('small'));

        expect(result.controllerCalled).toBe(true);
        expect(result.status).toBeNull();
        expect(result.body).toBeNull();
    });

    it('z opcjami dekoduje polską nazwę pliku z prawdziwego multipartu', async (): Promise<void> => {
        const form: FormData = new FormData();
        form.append('file', Buffer.from('%PDF-1.7'), {filename: 'żółw oferta.pdf', contentType: 'application/pdf'});

        const result: HttpInvocation = await invokeOverHttp({maxFileSize: 1024 * 1024}, form);

        expect(result.controllerCalled).toBe(true);
        expect(result.status).toBe(200);
        expect(result.originalName).toBe('żółw oferta.pdf');
    });

    it('z opcjami mapuje przekroczenie liczby pól na 413 JSON', async (): Promise<void> => {
        const form: FormData = new FormData();
        form.append('file', Buffer.from('x'), {filename: 'plik.pdf', contentType: 'application/pdf'});
        for (let index = 0; index < 21; index += 1) {
            form.append(`field${index}`, 'value');
        }

        const result: HttpInvocation = await invokeOverHttp({maxFileSize: 1024 * 1024}, form);

        expect(result.controllerCalled).toBe(false);
        expect(result.status).toBe(413);
        expect(result.body.errors).toEqual([
            expect.objectContaining({details: 'LIMIT_FIELD_COUNT', message: 'Too many form fields.'}),
        ]);
    });
});
