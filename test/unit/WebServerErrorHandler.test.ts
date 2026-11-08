import http from "http";
import path from "path";
import {AddressInfo} from "net";
import {Logger} from "@invilite/logger";
import WebServer from "../../src/infrastructure/Server/WebServer";
import {WebServerOptions} from "../../src/infrastructure/Server/WebServerOptions";
import {AuthService} from "../../src/services/AuthService";

const SIGNING_SECRET: string = 'error-handler-test-secret';

async function startServer(extraOptions: Partial<WebServerOptions>): Promise<{server: http.Server; port: number}> {
    const options: WebServerOptions = {
        trustProxy: false,
        controllersPath: path.resolve(__dirname, 'fixtures/error-handler'),
        ...extraOptions,
    };
    const webServer: WebServer = new WebServer(new Logger(), options, new AuthService('HS256', SIGNING_SECRET, SIGNING_SECRET, 'error-handler-test'));
    const server: http.Server = await webServer.listen(0);

    return {server, port: (server.address() as AddressInfo).port};
}

function postRaw(port: number, body: string): Promise<{status: number; text: string}> {
    return new Promise<{status: number; text: string}>((resolve: (result: {status: number; text: string}) => void, reject: (error: Error) => void): void => {
        const request: http.ClientRequest = http.request({host: '127.0.0.1', port, path: '/echo/', method: 'POST', headers: {'Content-Type': 'application/json'}}, (response: http.IncomingMessage): void => {
            let text: string = '';
            response.on('data', (chunk: Buffer): void => {
                text += chunk.toString('utf8');
            });
            response.on('end', (): void => resolve({status: response.statusCode ?? 0, text}));
        });
        request.on('error', reject);
        request.end(body);
    });
}

describe('WebServer terminal error handler', () => {
    const servers: http.Server[] = [];

    beforeAll(() => {
        process.env.COOKIE_SECRET = process.env.COOKIE_SECRET ?? 'test-cookie-secret';
        process.env.HOST_NAME = process.env.HOST_NAME ?? 'http://localhost';
    });

    afterEach(async () => {
        for (const server of servers.splice(0)) {
            server.closeAllConnections();
            await new Promise<void>((resolve: () => void): void => {
                server.close((): void => resolve());
            });
        }
    });

    it.each([
        ['without internalServerError', {}],
        ['with internalServerError', {internalServerError: {handler: (_error: unknown, _request: unknown, response: {status: (code: number) => {end: (text: string) => void}}): void => response.status(500).end('custom')}}],
    ])('answers a malformed JSON body with 400 and no stack trace %s', async (_label: string, extraOptions: Partial<WebServerOptions>) => {
        const {server, port} = await startServer(extraOptions);
        servers.push(server);

        const {status, text} = await postRaw(port, '{"broken":');

        expect(status).toBe(400);
        expect(text).toBe('Bad Request');
    });

    it('still serves a valid JSON body', async () => {
        const {server, port} = await startServer({});
        servers.push(server);

        const {status, text} = await postRaw(port, '{"title":"Hello"}');

        expect(status).toBe(200);
        expect(JSON.parse(text)).toEqual({received: {title: 'Hello'}});
    });
});
