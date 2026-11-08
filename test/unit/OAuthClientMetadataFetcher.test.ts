import {IncomingMessage, ServerResponse} from 'node:http';
import {createServer, Server} from 'node:https';
import {AddressInfo} from 'node:net';
import {
    ClientMetadataFetcher,
    ClientMetadataRequest,
    ClientMetadataResponse,
    requestMetadata,
    ResolvedAddress,
} from '../../src/services/OAuth/ClientMetadataFetcher';
import {OAuthClient} from '../../src/services/OAuth/OAuthTypes';

const CLIENT_URL: string = 'https://client.example/client.json';
const PUBLIC_ADDRESS: string = '93.184.216.34';
const REDIRECT_URI: string = 'https://client.example/callback';

interface ForgeCertificate {
    publicKey: unknown;
    serialNumber: string;
    validity: {notBefore: Date; notAfter: Date};
    setSubject(attributes: Array<{name: string; value: string}>): void;
    setIssuer(attributes: Array<{name: string; value: string}>): void;
    setExtensions(extensions: Array<Record<string, unknown>>): void;
    sign(key: unknown, digest: unknown): void;
}

interface ForgeModule {
    pki: {
        rsa: {generateKeyPair(bits: number): {publicKey: unknown; privateKey: unknown}};
        createCertificate(): ForgeCertificate;
        privateKeyToPem(key: unknown): string;
        certificateToPem(certificate: ForgeCertificate): string;
    };
    md: {sha256: {create(): unknown}};
}

const forge: ForgeModule = require('node-forge');

jest.setTimeout(15_000);

function publicAddress(): ResolvedAddress {
    return {address: PUBLIC_ADDRESS, family: 4};
}

function metadataDocument(clientId: string): string {
    return JSON.stringify({
        client_id: clientId,
        client_name: 'Example client',
        redirect_uris: [REDIRECT_URI],
    });
}

function transportReturning(body: string, statusCode: number = 200): jest.Mock<Promise<ClientMetadataResponse>, [ClientMetadataRequest]> {
    return jest.fn<Promise<ClientMetadataResponse>, [ClientMetadataRequest]>()
        .mockResolvedValue({statusCode, body});
}

function selfSignedCertificate(hostname: string): {key: string; cert: string} {
    const keys: {publicKey: unknown; privateKey: unknown} = forge.pki.rsa.generateKeyPair(2048);
    const certificate: ForgeCertificate = forge.pki.createCertificate();
    certificate.publicKey = keys.publicKey;
    certificate.serialNumber = '01';
    certificate.validity.notBefore = new Date();
    certificate.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const attributes: Array<{name: string; value: string}> = [{name: 'commonName', value: hostname}];
    certificate.setSubject(attributes);
    certificate.setIssuer(attributes);
    certificate.setExtensions([
        {name: 'basicConstraints', cA: true},
        {name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true},
        {name: 'subjectAltName', altNames: [{type: 2, value: hostname}]},
    ]);
    certificate.sign(keys.privateKey, forge.md.sha256.create());

    return {
        key: forge.pki.privateKeyToPem(keys.privateKey),
        cert: forge.pki.certificateToPem(certificate),
    };
}

function listen(server: Server): Promise<number> {
    return new Promise<number>((resolve): void => {
        server.listen(0, '127.0.0.1', (): void => {
            resolve((server.address() as AddressInfo).port);
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise<void>((resolve, reject): void => {
        server.close((error?: Error): void => error ? reject(error) : resolve());
    });
}

describe('ClientMetadataFetcher', () => {
    it('fetch rejects http URLs, hosts resolving to 10.0.0.0/8, 127.0.0.1 and 169.254.0.0/16, and documents larger than 64 KiB', async () => {
        const unusedTransport: jest.Mock<Promise<ClientMetadataResponse>, [ClientMetadataRequest]> = transportReturning(metadataDocument(CLIENT_URL));

        const httpFetcher: ClientMetadataFetcher = new ClientMetadataFetcher({
            resolver: jest.fn<Promise<ResolvedAddress[]>, [string]>().mockResolvedValue([publicAddress()]),
            transport: unusedTransport,
        });
        await expect(httpFetcher.fetch('http://client.example/client.json')).rejects.toThrow(/HTTPS/);

        const blockedAddresses: string[] = [
            '10.1.2.3',
            '127.0.0.1',
            '169.254.10.20',
            '::ffff:10.0.0.5',
            '::ffff:0:127.0.0.1',
            '::ffff:0:7f00:1',
            '::10.0.0.5',
            '64:ff9b::10.0.0.5',
            '2002:0a00:0005::',
            'fc00::1',
            'fec0::1',
        ];
        for (const address of blockedAddresses) {
            const blockedFetcher: ClientMetadataFetcher = new ClientMetadataFetcher({
                resolver: jest.fn<Promise<ResolvedAddress[]>, [string]>()
                    .mockResolvedValue([{address, family: address.includes(':') ? 6 : 4}]),
                transport: unusedTransport,
            });
            await expect(blockedFetcher.fetch(CLIENT_URL)).rejects.toThrow(/non-public/);
        }

        const oversizedFetcher: ClientMetadataFetcher = new ClientMetadataFetcher({
            resolver: jest.fn<Promise<ResolvedAddress[]>, [string]>().mockResolvedValue([publicAddress()]),
            transport: transportReturning(JSON.stringify({
                client_id: CLIENT_URL,
                client_name: 'Oversized',
                redirect_uris: [REDIRECT_URI],
                padding: 'x'.repeat(65 * 1024),
            })),
        });
        await expect(oversizedFetcher.fetch(CLIENT_URL)).rejects.toThrow(/64 KiB/);

        expect(unusedTransport).not.toHaveBeenCalled();
    });

    it('fetch rejects a document whose client_id differs from its URL', async () => {
        const fetcher: ClientMetadataFetcher = new ClientMetadataFetcher({
            resolver: jest.fn<Promise<ResolvedAddress[]>, [string]>().mockResolvedValue([publicAddress()]),
            transport: transportReturning(metadataDocument('https://other.example/client.json')),
        });

        await expect(fetcher.fetch(CLIENT_URL)).rejects.toThrow(/client_id/);
    });

    it('fetch returns the metadata client, connects to the vetted address and caches the result for one hour', async () => {
        let now: number = 1_000_000;
        const transport: jest.Mock<Promise<ClientMetadataResponse>, [ClientMetadataRequest]> = transportReturning(metadataDocument(CLIENT_URL));
        const fetcher: ClientMetadataFetcher = new ClientMetadataFetcher({
            resolver: jest.fn<Promise<ResolvedAddress[]>, [string]>().mockResolvedValue([publicAddress()]),
            transport,
            now: (): number => now,
        });

        const client: OAuthClient = await fetcher.fetch(CLIENT_URL);
        expect(client).toEqual({
            clientId: CLIENT_URL,
            clientName: 'Example client',
            redirectUris: [REDIRECT_URI],
            source: 'metadata_document',
        });
        expect(transport).toHaveBeenCalledTimes(1);
        expect(transport.mock.calls[0][0].address).toBe(PUBLIC_ADDRESS);
        expect(transport.mock.calls[0][0].hostname).toBe('client.example');

        await fetcher.fetch(CLIENT_URL);
        expect(transport).toHaveBeenCalledTimes(1);

        now += 60 * 60 * 1000 + 1;
        await fetcher.fetch(CLIENT_URL);
        expect(transport).toHaveBeenCalledTimes(2);
    });

    it('fetch keeps the metadata cache bounded to the newest 1000 entries', async () => {
        const transport: jest.Mock<Promise<ClientMetadataResponse>, [ClientMetadataRequest]> = jest.fn<
            Promise<ClientMetadataResponse>,
            [ClientMetadataRequest]
        >().mockImplementation(async (request: ClientMetadataRequest): Promise<ClientMetadataResponse> => ({
            statusCode: 200,
            body: metadataDocument(request.url),
        }));
        const fetcher: ClientMetadataFetcher = new ClientMetadataFetcher({
            resolver: jest.fn<Promise<ResolvedAddress[]>, [string]>().mockResolvedValue([publicAddress()]),
            transport,
        });

        for (let index: number = 0; index < 1001; index += 1) {
            await fetcher.fetch(`https://client.example/client-${index}.json`);
        }

        await fetcher.fetch('https://client.example/client-0.json');
        expect(transport).toHaveBeenCalledTimes(1002);
    });

    it('fetch rejects a non-success response and a redirect URI that is not HTTPS or a loopback HTTP URL', async () => {
        const failingFetcher: ClientMetadataFetcher = new ClientMetadataFetcher({
            resolver: jest.fn<Promise<ResolvedAddress[]>, [string]>().mockResolvedValue([publicAddress()]),
            transport: transportReturning(metadataDocument(CLIENT_URL), 404),
        });
        await expect(failingFetcher.fetch(CLIENT_URL)).rejects.toThrow(/status/);

        const unsafeRedirectFetcher: ClientMetadataFetcher = new ClientMetadataFetcher({
            resolver: jest.fn<Promise<ResolvedAddress[]>, [string]>().mockResolvedValue([publicAddress()]),
            transport: transportReturning(JSON.stringify({
                client_id: CLIENT_URL,
                client_name: 'Unsafe',
                redirect_uris: ['http://client.example/callback'],
            })),
        });
        await expect(unsafeRedirectFetcher.fetch(CLIENT_URL)).rejects.toThrow(/redirect_uri/);

        const trailingHashFetcher: ClientMetadataFetcher = new ClientMetadataFetcher({
            resolver: jest.fn<Promise<ResolvedAddress[]>, [string]>().mockResolvedValue([publicAddress()]),
            transport: transportReturning(JSON.stringify({
                client_id: CLIENT_URL,
                client_name: 'Trailing hash',
                redirect_uris: [`${REDIRECT_URI}#`],
            })),
        });
        await expect(trailingHashFetcher.fetch(CLIENT_URL)).rejects.toThrow(/redirect_uri/);
    });

    it('fetch enforces a five second wall-clock deadline over a resolver that never settles', async () => {
        jest.useFakeTimers();
        try {
            const fetcher: ClientMetadataFetcher = new ClientMetadataFetcher({
                resolver: (): Promise<ResolvedAddress[]> => new Promise<ResolvedAddress[]>(() => undefined),
                transport: transportReturning(metadataDocument(CLIENT_URL)),
            });

            const result: Promise<OAuthClient> = fetcher.fetch(CLIENT_URL);
            const rejection: Promise<void> = expect(result).rejects.toThrow(/timed out/);
            await jest.advanceTimersByTimeAsync(5_001);
            await rejection;
        } finally {
            jest.useRealTimers();
        }
    });

    it('fetch enforces the five second deadline over a transport that never settles and aborts its signal', async () => {
        jest.useFakeTimers();
        try {
            const capturedSignals: AbortSignal[] = [];
            const fetcher: ClientMetadataFetcher = new ClientMetadataFetcher({
                resolver: jest.fn<Promise<ResolvedAddress[]>, [string]>().mockResolvedValue([publicAddress()]),
                transport: (request: ClientMetadataRequest): Promise<ClientMetadataResponse> => {
                    capturedSignals.push(request.signal);

                    return new Promise<ClientMetadataResponse>(() => undefined);
                },
            });

            const result: Promise<OAuthClient> = fetcher.fetch(CLIENT_URL);
            const rejection: Promise<void> = expect(result).rejects.toThrow(/timed out/);
            await jest.advanceTimersByTimeAsync(5_001);
            await rejection;

            expect(capturedSignals).toHaveLength(1);
            expect(capturedSignals[0].aborted).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    it('requestMetadata connects to the pinned address with SNI and validates the certificate', async () => {
        const material: {key: string; cert: string} = selfSignedCertificate('pinned.invalid');
        const body: string = metadataDocument('https://pinned.invalid/client.json');
        const server: Server = createServer({key: material.key, cert: material.cert}, (_request: IncomingMessage, response: ServerResponse): void => {
            response.writeHead(200, {'content-type': 'application/json'});
            response.end(body);
        });
        const port: number = await listen(server);

        try {
            const response: ClientMetadataResponse = await requestMetadata({
                url: 'https://pinned.invalid/client.json',
                hostname: 'pinned.invalid',
                port: String(port),
                path: '/client.json',
                address: '127.0.0.1',
                family: 4,
                timeoutMs: 5_000,
                maxBytes: 64 * 1024,
                signal: new AbortController().signal,
                ca: material.cert,
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toBe(body);
        } finally {
            server.closeAllConnections();
            await close(server);
        }
    });

    it('requestMetadata aborts a response that exceeds the 64 KiB streaming cap', async () => {
        const material: {key: string; cert: string} = selfSignedCertificate('pinned.invalid');
        const server: Server = createServer({key: material.key, cert: material.cert}, (_request: IncomingMessage, response: ServerResponse): void => {
            response.on('error', (): void => undefined);
            response.writeHead(200);
            const chunk: Buffer = Buffer.alloc(1024, 'x');
            for (let index: number = 0; index < 70; index += 1) {
                response.write(chunk);
            }
            response.end();
        });
        const port: number = await listen(server);

        try {
            await expect(requestMetadata({
                url: 'https://pinned.invalid/client.json',
                hostname: 'pinned.invalid',
                port: String(port),
                path: '/client.json',
                address: '127.0.0.1',
                family: 4,
                timeoutMs: 5_000,
                maxBytes: 64 * 1024,
                signal: new AbortController().signal,
                ca: material.cert,
            })).rejects.toThrow(/64 KiB/);
        } finally {
            server.closeAllConnections();
            await close(server);
        }
    });
});
