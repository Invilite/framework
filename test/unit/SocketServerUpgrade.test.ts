import http from "http";
import {Duplex} from "stream";
import net, {AddressInfo} from "net";
import WebSocket from "ws";
import {Logger} from "@invilite/logger";
import SocketServer, {SocketServerOptions, SocketUpgradeDecision} from "../../src/infrastructure/Server/SocketServer";
import {AuthService} from "../../src/services/AuthService";

const SIGNING_SECRET: string = 'socket-server-test-secret';

interface Started {
    server: http.Server;
    socketServer: SocketServer;
    url: string;
}

async function start(decide: ((request: http.IncomingMessage) => Promise<SocketUpgradeDecision>) | null, maxPayload?: number): Promise<Started> {
    const server: http.Server = http.createServer();
    const authService: AuthService = new AuthService('HS256', SIGNING_SECRET, SIGNING_SECRET, 'socket-server-test');
    const socketServer: SocketServer = new SocketServer(server, '/socket', new Logger(), authService, undefined, {
        maxPayload,
        beforeUpgrade: decide ?? undefined,
    });
    await new Promise<void>((resolve: () => void): void => {
        server.listen(0, '127.0.0.1', resolve);
    });

    return {server, socketServer, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket`};
}

function refusedWith(url: string): Promise<number> {
    return new Promise<number>((resolve: (status: number) => void, reject: (error: Error) => void): void => {
        const client: WebSocket = new WebSocket(url);
        client.on('unexpected-response', (_request: http.ClientRequest, response: http.IncomingMessage): void => {
            resolve(response.statusCode ?? 0);
            client.terminate();
        });
        client.on('open', (): void => reject(new Error('The socket opened')));
        client.on('error', (): void => undefined);
    });
}

describe("SocketServer upgrade decision", () => {
    const started: Started[] = [];

    beforeAll(() => {
        process.env.COOKIE_SECRET = process.env.COOKIE_SECRET ?? 'test-cookie-secret';
    });

    afterEach(async () => {
        for (const {server, socketServer} of started.splice(0)) {
            socketServer.closeAllConnections();
            server.closeAllConnections();
            await new Promise<void>((resolve: () => void): void => {
                server.close((): void => resolve());
            });
        }
    });

    it.each([401, 403, 404])("refuses the upgrade with %i and never opens the socket", async (status: number) => {
        const opened: jest.Mock = jest.fn();
        const run: Started = await start(async (): Promise<SocketUpgradeDecision> => ({accept: false, status}));
        started.push(run);
        run.socketServer.on('connection', opened);

        expect(await refusedWith(run.url)).toBe(status);
        expect(opened).not.toHaveBeenCalled();
    });

    it("answers 500 when the check itself fails", async () => {
        const run: Started = await start(async (): Promise<SocketUpgradeDecision> => {
            throw new Error('check failed');
        });
        started.push(run);

        expect(await refusedWith(run.url)).toBe(500);
    });

    it("hands the context of an accepted upgrade to the connection listener", async () => {
        const run: Started = await start(async (): Promise<SocketUpgradeDecision> => ({accept: true, context: {room: 1}}));
        started.push(run);
        const context: Promise<unknown> = new Promise<unknown>((resolve: (value: unknown) => void): void => {
            run.socketServer.on('connection', (_ws: WebSocket, _request: http.IncomingMessage, upgradeContext: unknown): void => resolve(upgradeContext));
        });

        const client: WebSocket = new WebSocket(run.url);
        client.on('error', (): void => undefined);
        expect(await context).toEqual({room: 1});
        client.terminate();
    });

    it("closes a connection whose frame is over the payload limit with 1009", async () => {
        const run: Started = await start(null, 16 * 1024);
        started.push(run);
        run.socketServer.on('connection', (): void => undefined);

        const client: WebSocket = new WebSocket(run.url);
        await new Promise<void>((resolve: () => void): void => {
            client.on('open', (): void => resolve());
        });
        const closed: Promise<number> = new Promise<number>((resolve: (code: number) => void): void => {
            client.on('close', (code: number): void => resolve(code));
        });
        client.send('a'.repeat(20_000));

        expect(await closed).toBe(1009);
    });
});

describe("SocketServer upgrade robustness", () => {
    const servers: {server: http.Server; socketServer: SocketServer}[] = [];

    beforeAll(() => {
        process.env.COOKIE_SECRET = process.env.COOKIE_SECRET ?? 'test-cookie-secret';
    });

    afterEach(async () => {
        for (const {server, socketServer} of servers.splice(0)) {
            socketServer.closeAllConnections();
            server.closeAllConnections();
            await new Promise<void>((resolve: () => void): void => {
                server.close((): void => resolve());
            });
        }
    });

    async function startWith(options: SocketServerOptions): Promise<{server: http.Server; socketServer: SocketServer; port: number}> {
        const server: http.Server = http.createServer();
        const authService: AuthService = new AuthService('HS256', SIGNING_SECRET, SIGNING_SECRET, 'socket-server-test');
        const socketServer: SocketServer = new SocketServer(server, '/socket', new Logger(), authService, undefined, options);
        await new Promise<void>((resolve: () => void): void => {
            server.listen(0, '127.0.0.1', resolve);
        });
        servers.push({server, socketServer});

        return {server, socketServer, port: (server.address() as AddressInfo).port};
    }

    function rawUpgrade(port: number, requestPath: string, host: string): Promise<string> {
        return new Promise<string>((resolve: (statusLine: string) => void): void => {
            const socket: net.Socket = net.connect(port, '127.0.0.1', (): void => {
                socket.write(
                    `GET ${requestPath} HTTP/1.1\r\n` +
                    `Host: ${host}\r\n` +
                    'Connection: Upgrade\r\n' +
                    'Upgrade: websocket\r\n' +
                    'Sec-WebSocket-Version: 13\r\n' +
                    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
                    '\r\n'
                );
            });
            let received: string = '';
            socket.on('data', (chunk: Buffer): void => {
                received += chunk.toString('latin1');
                if (received.includes('\r\n')) {
                    resolve(received.split('\r\n')[0]);
                    socket.destroy();
                }
            });
            socket.on('close', (): void => resolve(received.split('\r\n')[0]));
            socket.on('error', (): void => undefined);
        });
    }

    function opens(port: number): Promise<boolean> {
        return new Promise<boolean>((resolve: (opened: boolean) => void): void => {
            const client: WebSocket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
            client.on('open', (): void => {
                resolve(true);
                client.terminate();
            });
            client.on('unexpected-response', (): void => resolve(false));
            client.on('error', (): void => resolve(false));
        });
    }

    it("answers 404 to an upgrade on a path without a socket server", async () => {
        const {port} = await startWith({});

        expect(await rawUpgrade(port, '/elsewhere', 'example.com')).toBe('HTTP/1.1 404 Not Found');
    });

    it("keeps serving after an upgrade with an unparsable Host header", async () => {
        const {port} = await startWith({});

        expect(await rawUpgrade(port, '/socket', 'a b')).toMatch(/^HTTP\/1\.1 /);
        expect(await opens(port)).toBe(true);
    });

    it("keeps serving after the client resets the connection during the upgrade check", async () => {
        const {port} = await startWith({
            beforeUpgrade: async (): Promise<SocketUpgradeDecision> => {
                await new Promise<void>((resolve: () => void): void => {
                    setTimeout(resolve, 100);
                });
                return {accept: true};
            },
        });

        const socket: net.Socket = net.connect(port, '127.0.0.1', (): void => {
            socket.write(
                'GET /socket HTTP/1.1\r\nHost: example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
                'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
            );
            setTimeout((): void => {
                socket.resetAndDestroy();
            }, 20);
        });
        socket.on('error', (): void => undefined);
        await new Promise<void>((resolve: () => void): void => {
            setTimeout(resolve, 250);
        });

        expect(await opens(port)).toBe(true);
    });

    it("closes the connection with 1011 when an async connection listener rejects", async () => {
        const {port, socketServer} = await startWith({});
        socketServer.on('connection', async (): Promise<void> => {
            throw new Error('listener failed');
        });

        const closeCode: number = await new Promise<number>((resolve: (code: number) => void): void => {
            const client: WebSocket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
            client.on('close', (code: number): void => resolve(code));
            client.on('error', (): void => undefined);
        });

        expect(closeCode).toBe(1011);
    });

    it("takes the client address from the resolver it was given", async () => {
        const clientAddress: jest.Mock = jest.fn((): string => '203.0.113.7');
        const {port} = await startWith({clientAddress});

        expect(await opens(port)).toBe(true);
        expect(clientAddress).toHaveBeenCalledTimes(1);
    });

    it("leaves an unknown upgrade path to another upgrade listener of the same HTTP server", async () => {
        const {server, port} = await startWith({});
        server.on('upgrade', (_request: http.IncomingMessage, socket: Duplex): void => {
            socket.end('HTTP/1.1 418 I\'m a Teapot\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        });

        expect(await rawUpgrade(port, '/elsewhere', 'example.com')).toBe("HTTP/1.1 418 I'm a Teapot");
    });

    it("refuses a second socket server on the same path of one HTTP server", async () => {
        const {server} = await startWith({});
        const authService: AuthService = new AuthService('HS256', SIGNING_SECRET, SIGNING_SECRET, 'socket-server-test');

        expect((): SocketServer => new SocketServer(server, '/socket', new Logger(), authService)).toThrow('already has a WebSocket server');
    });
});
