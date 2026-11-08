import http from "http";
import WebSocket from "ws";
import {Duplex} from "stream";
import {Env} from "../../utils/Env";
import {UnauthorizedError} from "../../errors/ApplicationError/HttpError";
import {ExpressMiddleware, RunMiddlewares} from "./MiddlewareAdapter";
import {Logger} from "@invilite/logger";
import {AuthService} from "../../services/AuthService";
import TokenBlacklistService from "../../services/TokenBlacklistService";
import {AuthorizationMiddleware} from "./http/middleware";
import cookieParser from "cookie-parser";
import {customAlphabet} from "nanoid";
import {ExtendedWebSocket} from "../../models/ExtendedWebSocket";

/** Whether an upgrade goes ahead; `context` reaches the `connection` listener as its third argument. */
export type SocketUpgradeDecision = {accept: true; context?: unknown} | {accept: false; status: number};

export interface SocketServerOptions {
    /** Longest frame `ws` accepts; a longer one closes the connection with 1009 before it is read whole. */
    maxPayload?: number;
    /** Runs after the authentication middleware and before the upgrade, so a refused socket is never opened. */
    beforeUpgrade?: (request: http.IncomingMessage) => Promise<SocketUpgradeDecision>;
    clientAddress?: (request: http.IncomingMessage) => string | undefined;
}

type UpgradeHandler = (request: http.IncomingMessage, socket: Duplex, upgradeHead: Buffer) => void;
type ConnectionListener = (ws: WebSocket, request: http.IncomingMessage, context: unknown) => unknown;

const upgradeHandlers: WeakMap<http.Server, Map<string, UpgradeHandler>> = new WeakMap<http.Server, Map<string, UpgradeHandler>>();

function pathnameOf(requestUrl: string | undefined): string {
    const target: string = requestUrl ?? '';
    const queryStart: number = target.search(/[?#]/);
    return queryStart === -1 ? target : target.slice(0, queryStart);
}

function rejectHandshake(socket: Duplex, statusCode: number): void {
    if (socket.destroyed || !socket.writable) {
        socket.destroy();
        return;
    }
    const message: string = http.STATUS_CODES[statusCode] || 'Rejected';
    socket.once('finish', socket.destroy);
    socket.end(
        `HTTP/1.1 ${statusCode} ${message}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/html\r\n' +
        `Content-Length: ${Buffer.byteLength(message)}\r\n` +
        '\r\n' +
        message
    );
}

function handlersOf(server: http.Server): Map<string, UpgradeHandler> {
    const existing: Map<string, UpgradeHandler> | undefined = upgradeHandlers.get(server);
    if (existing !== undefined) {
        return existing;
    }

    const handlers: Map<string, UpgradeHandler> = new Map<string, UpgradeHandler>();
    server.on('upgrade', (request: http.IncomingMessage, socket: Duplex, upgradeHead: Buffer): void => {
        socket.on('error', (): void => {
            socket.destroy();
        });
        const handler: UpgradeHandler | undefined = handlers.get(pathnameOf(request.url));
        if (handler !== undefined) {
            handler(request, socket, upgradeHead);
            return;
        }
        if (server.listenerCount('upgrade') === 1) {
            rejectHandshake(socket, 404);
        }
    });
    upgradeHandlers.set(server, handlers);

    return handlers;
}

export default class SocketServer extends WebSocket.WebSocketServer {
    private readonly connections: Set<WebSocket> = new Set<WebSocket>();
    private readonly generateSocketId: () => string;
    private readonly middlewares: ((request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>)[];

    public constructor(
        protected readonly server: http.Server,
        path: string,
        private readonly logger: Logger,
        authService: AuthService,
        tokenBlacklist?: TokenBlacklistService,
        private readonly upgradeOptions: SocketServerOptions = {},
    ) {
        super({
            backlog: 100,
            noServer: true,
            path,
            ...(upgradeOptions.maxPayload !== undefined ? {maxPayload: upgradeOptions.maxPayload} : {}),
        });

        this.generateSocketId = customAlphabet('QWERTYUIOPASDFGHJKLZXCVBNMqwertyuiopasdfghjklzxcvbnm1234567890', 16);
        this.middlewares = [
            cookieParser(Env.requireString('COOKIE_SECRET')),
            AuthorizationMiddleware(authService, tokenBlacklist),
        ].map(ExpressMiddleware);

        const handlers: Map<string, UpgradeHandler> = handlersOf(server);
        if (handlers.has(path)) {
            throw new Error(`[SocketServer] The path "${path}" already has a WebSocket server`);
        }
        handlers.set(path, (request: http.IncomingMessage, socket: Duplex, upgradeHead: Buffer): void => {
            this.upgrade(request, socket, upgradeHead).catch((error: unknown): void => {
                this.logger.error(`WebSocket upgrade failed: ${(error as {message?: string} | null)?.message || error}`);
                rejectHandshake(socket, 500);
            });
        });
    }

    public closeAllConnections(): void {
        for (const socket of this.connections) {
            socket.close(1000, 'Server shutdown');
        }
    }

    private async upgrade(request: http.IncomingMessage, socket: Duplex, upgradeHead: Buffer): Promise<void> {
        try {
            await RunMiddlewares(request, {} as http.ServerResponse, this.middlewares);
        } catch (e: unknown) {
            const unauthorized: boolean = e instanceof UnauthorizedError;
            if (!unauthorized) {
                this.logger.error(`WebSocket upgrade middleware failed: ${(e as {message?: string} | null)?.message || e}`);
            }
            return rejectHandshake(socket, unauthorized ? 401 : 500);
        }

        let upgradeContext: unknown = undefined;
        if (this.upgradeOptions.beforeUpgrade) {
            let decision: SocketUpgradeDecision;
            try {
                decision = await this.upgradeOptions.beforeUpgrade(request);
            } catch (e: unknown) {
                this.logger.error(`WebSocket upgrade check failed: ${(e as {message?: string} | null)?.message || e}`);
                return rejectHandshake(socket, 500);
            }
            if (!decision.accept) {
                return rejectHandshake(socket, decision.status);
            }
            upgradeContext = decision.context;
        }

        if (socket.destroyed) {
            return;
        }

        const socketId: string = this.generateSocketId();
        const requestLogs: Logger = this.logger.clone({
            requestId: socketId
        });

        this.handleUpgrade(request, socket, upgradeHead, (ws: WebSocket): void => {
            this.accept(ws, request, upgradeContext, socketId, requestLogs);
        });
    }

    private accept(ws: WebSocket, request: http.IncomingMessage, upgradeContext: unknown, socketId: string, requestLogs: Logger): void {
        requestLogs.info(`WebSocket ${request.url} connection open (${this.clientAddressOf(request)})`);
        ws.on('error', (error: Error): void => {
            requestLogs.error(error.message || error);
        });
        ws.once('close', (code: number, reason: Buffer): void => {
            requestLogs.info('Connection closed with code', code, 'reason:', reason.toString() || 'unknown');

            setImmediate(() => {
                ws.removeAllListeners();
                this.connections.delete(ws);
            });
        });

        (ws as ExtendedWebSocket).logger = requestLogs;
        (ws as ExtendedWebSocket).socketId = socketId;
        this.connections.add(ws);

        for (const listener of this.rawListeners('connection') as ConnectionListener[]) {
            try {
                const result: unknown = listener.call(this, ws, request, upgradeContext);
                if (result instanceof Promise) {
                    result.catch((error: unknown): void => this.failConnection(ws, error, requestLogs));
                }
            } catch (error: unknown) {
                this.failConnection(ws, error, requestLogs);
            }
        }
    }

    private failConnection(ws: WebSocket, error: unknown, requestLogs: Logger): void {
        requestLogs.error(error);
        if (error instanceof UnauthorizedError) {
            ws.close(4401, 'Unauthorized');
            return;
        }
        ws.close(1011, 'Internal error');
    }

    private clientAddressOf(request: http.IncomingMessage): string {
        const address: string | undefined = this.upgradeOptions.clientAddress
            ? this.upgradeOptions.clientAddress(request)
            : request.socket.remoteAddress;

        return address || 'unknown';
    }
}
