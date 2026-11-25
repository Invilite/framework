import fs from "fs";
import http from "http";
import path from "path";
import {createHash} from "crypto";
import express, {Express} from "express";
import {Logger} from "@invilite/logger";
import {Class} from "../../utils/Class";
import SocketServer, {SocketUpgradeDecision} from "./SocketServer";
import {WebServerSocketOptions} from "./WebServerOptions";
import {SocketHub, SocketHubConnection, SocketMessageHandler, SocketPeer, SocketSessionCheck} from "./socket/SocketHub";
import {SocketProtocol} from "./socket/SocketProtocol";
import {AbstractSocketController} from "../../controllers/AbstractSocketController";
import {AbstractSocketEndpoint} from "../../controllers/AbstractSocketEndpoint";
import {readSocketChannel, SocketChannelDefinition} from "../../decorators/WebServer/SocketChannel";
import {readSocketEndpoint, SocketEndpointDefinition} from "../../decorators/WebServer/SocketEndpoint";
import {readSocketMessages, SocketMessageDefinition} from "../../decorators/WebServer/SocketMessage";
import {hasRequiredRoles, readRequiredAuth, unguardedMethod} from "../../decorators/WebServer/RequiresAuth";
import {ExtendedRequest} from "../../models/ExtendedRequest";
import {ExtendedWebSocket} from "../../models/ExtendedWebSocket";
import {AuthService} from "../../services/AuthService";
import TokenBlacklistService from "../../services/TokenBlacklistService";
import {SocketConnection} from "../../types/interfaces/SocketConnection";
import {SocketContext} from "../../types/interfaces/SocketContext";

/** A class found by the scan; abstract, because only its metadata and base class are known at that point. */
type SocketClass = abstract new (...parameters: never[]) => object;

interface ScannedClass {
    target: SocketClass;
    className: string;
    file: string;
}

interface Endpoint {
    path: string;
    instance: AbstractSocketEndpoint;
    hub: SocketHub;
}

interface ClientFile {
    content: string;
    version: string;
}

export interface SocketRegistryContext {
    server: http.Server;
    express: Express;
    logger: Logger;
    authService: AuthService;
    tokenBlacklist?: TokenBlacklistService;
    options?: WebServerSocketOptions;
    controllerParams?: unknown[];
    /** Paths already served by @WebSocketListener; two upgrade handlers on one path would both take the socket. */
    listenerPaths?: ReadonlySet<string>;
    clientAddress?: (request: http.IncomingMessage) => string | undefined;
}

/**
 * The socket side of WebServer: collects @SocketEndpoint and @SocketChannel classes found while scanning the controller
 * directories, checks them as a whole once the scan is over (any mistake stops the start - half a channel layer is
 * worse than none), builds a hub per endpoint and serves the browser client of the protocol.
 */
export class SocketRegistry {
    public static readonly CLIENT_FILES: readonly string[] = ['websocket-events.js', 'websocket-events-worker.js', 'websocket-events-connection.js'];

    private static readonly CLIENT_DIRECTORY: string = path.resolve(__dirname, '../../client/socket');

    private static readonly ENDPOINT_PATH_PATTERN: RegExp = /^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

    private readonly scanned: ScannedClass[] = [];
    private readonly endpoints: Map<string, Endpoint> = new Map<string, Endpoint>();
    private readonly socketServers: SocketServer[] = [];
    private clientFiles: Map<string, ClientFile> | null = null;

    /** True for a class this registry takes over from the controller scan. */
    public collect(target: SocketClass, className: string, file: string): boolean {
        if (readSocketEndpoint(target) === null && readSocketChannel(target) === null && readSocketMessages(target).length === 0) {
            return false;
        }
        this.scanned.push({target, className, file});

        return true;
    }

    public build(context: SocketRegistryContext): void {
        if (this.scanned.length === 0) {
            return;
        }
        const endpointClasses: ScannedClass[] = this.scanned.filter((scanned: ScannedClass): boolean => readSocketEndpoint(scanned.target) !== null);
        const channelClasses: ScannedClass[] = this.scanned.filter((scanned: ScannedClass): boolean => readSocketEndpoint(scanned.target) === null);
        if (endpointClasses.length > 0 && context.options === undefined) {
            throw new Error(`@SocketEndpoint in "${endpointClasses[0].className}" (${endpointClasses[0].file}) needs WebServerOptions.socket`);
        }

        for (const scanned of endpointClasses) {
            this.buildEndpoint(scanned, context);
        }
        if (endpointClasses.length > 0) {
            // At the start, so a build that left the scripts out stops here instead of failing the first page.
            this.loadClientFiles();
        }
        for (const scanned of channelClasses) {
            this.buildChannel(scanned, context.controllerParams);
        }
        for (const endpoint of this.endpoints.values()) {
            this.serve(endpoint, context);
        }
    }

    /** The `beforeUpgrade` of a @WebSocketListener method: its @RequiresAuth, checked on the upgrade request. */
    public static listenerDecision(controller: object, method: string): ((request: http.IncomingMessage) => Promise<SocketUpgradeDecision>) | undefined {
        if (readRequiredAuth(controller, method) === null) {
            return undefined;
        }

        return async (request: http.IncomingMessage): Promise<SocketUpgradeDecision> => SocketRegistry.authorize(controller, method, request) ?? {accept: true};
    }

    /** `{{{socketClient '/ws'}}}` in a layout: the script tag of the browser client for an endpoint and the page's account. */
    public scriptTag(endpointPath: string, userId: unknown): string {
        if (!this.endpoints.has(endpointPath)) {
            throw new Error(`socketClient: no @SocketEndpoint at "${endpointPath}"`);
        }
        const files: Map<string, ClientFile> = this.loadClientFiles();
        const facade: ClientFile = files.get('websocket-events.js') as ClientFile;
        const worker: ClientFile = files.get('websocket-events-worker.js') as ClientFile;
        const connection: ClientFile = files.get('websocket-events-connection.js') as ClientFile;
        const base: string = `${endpointPath}/client`;
        const attribute: (value: string) => string = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

        return `<script src="${attribute(`${base}/websocket-events.js?v=${facade.version}`)}"`
            + ` data-endpoint="${attribute(endpointPath)}"`
            + ` data-user="${typeof userId === 'number' ? userId : ''}"`
            + ` data-worker="${attribute(`${base}/websocket-events-worker.js?v=${worker.version}&c=${connection.version}`)}"`
            + ` data-connection="${attribute(`${base}/websocket-events-connection.js?v=${connection.version}`)}"></script>`;
    }

    public close(): void {
        for (const socketServer of this.socketServers) {
            socketServer.closeAllConnections();
        }
        for (const endpoint of this.endpoints.values()) {
            endpoint.hub.stop();
        }
    }

    /** @RequiresAuth of a socket entry: like HTTP, no roles = an account (401), roles = hidden from anyone without them (404). */
    private static authorize(target: object, method: string, request: http.IncomingMessage): SocketUpgradeDecision | null {
        const required: {roles: string[] | null} | null = readRequiredAuth(target, method);
        const auth: ExtendedRequest['auth'] = (request as ExtendedRequest).auth;
        if (required === null) {
            return null;
        }
        if (required.roles !== null) {
            return hasRequiredRoles(auth, required.roles) ? null : {accept: false, status: 404};
        }

        return auth ? null : {accept: false, status: 401};
    }

    private buildEndpoint(scanned: ScannedClass, context: SocketRegistryContext): void {
        const definition: SocketEndpointDefinition = readSocketEndpoint(scanned.target) as SocketEndpointDefinition;
        this.ensure(Class.isInheritedFrom(scanned.target as unknown as new () => object, AbstractSocketEndpoint), scanned, 'a @SocketEndpoint must extend AbstractSocketEndpoint');
        this.ensure(readSocketChannel(scanned.target) === null && readSocketMessages(scanned.target).length === 0, scanned, 'a @SocketEndpoint cannot be a channel too');
        this.ensure(typeof definition.path === 'string' && SocketRegistry.ENDPOINT_PATH_PATTERN.test(definition.path), scanned, `invalid endpoint path "${definition.path}"`);
        this.ensure(!this.endpoints.has(definition.path), scanned, `a second @SocketEndpoint at "${definition.path}"`);
        this.ensure(!(context.listenerPaths?.has(definition.path) ?? false), scanned, `"${definition.path}" is already a @WebSocketListener path`);

        const options: WebServerSocketOptions = context.options as WebServerSocketOptions;
        const instance: AbstractSocketEndpoint = new (scanned.target as unknown as new (parameters?: unknown[]) => AbstractSocketEndpoint)(context.controllerParams);
        const hub: SocketHub = new SocketHub({
            broker: options.publisher.broker,
            subjectPrefix: options.publisher.subjectPrefix,
            log: context.logger,
            limits: options.limits,
            disconnect: (connection: SocketConnection): void | Promise<void> => instance.disconnect?.(connection),
        });
        this.endpoints.set(definition.path, {path: definition.path, instance, hub});
    }

    private buildChannel(scanned: ScannedClass, controllerParams: unknown[] | undefined): void {
        const definition: SocketChannelDefinition | null = readSocketChannel(scanned.target);
        this.ensure(definition !== null, scanned, '@SocketMessage needs @SocketChannel on the class');
        const channel: SocketChannelDefinition = definition as SocketChannelDefinition;
        this.ensure(Class.isInheritedFrom(scanned.target as unknown as new () => object, AbstractSocketController), scanned, 'a @SocketChannel must extend AbstractSocketController');
        this.ensure(SocketProtocol.isChannelType(channel.type), scanned, `invalid channel type "${channel.type}"`);
        const endpoint: Endpoint = this.endpointOf(scanned, channel);

        const instance: AbstractSocketController = new (scanned.target as unknown as new (parameters?: unknown[]) => AbstractSocketController)(controllerParams);
        const messages: Map<string, SocketMessageHandler> = new Map<string, SocketMessageHandler>();
        for (const message of readSocketMessages(scanned.target)) {
            this.ensure(SocketProtocol.isEventType(message.type), scanned, `invalid message type "${message.type}"`);
            this.ensure(!messages.has(message.type), scanned, `a second @SocketMessage('${message.type}')`);
            this.ensure(typeof unguardedMethod(instance, message.method) === 'function', scanned, `@SocketMessage('${message.type}') is not on a method`);
            messages.set(message.type, SocketRegistry.messageHandler(instance, message));
        }

        try {
            endpoint.hub.register(channel.type, {
                lossy: channel.lossy,
                presence: channel.presence,
                join: (context: SocketContext): boolean | Promise<boolean> => instance.join(context),
                leave: (context: SocketContext): void | Promise<void> => instance.leave?.(context),
                messages,
            });
        } catch (error) {
            this.ensure(false, scanned, (error as Error).message);
        }
    }

    private static messageHandler(instance: AbstractSocketController, message: SocketMessageDefinition): SocketMessageHandler {
        const required: {roles: string[] | null} | null = readRequiredAuth(instance, message.method);
        const method: (...args: unknown[]) => unknown = unguardedMethod(instance, message.method);

        return {
            requiresLogin: required !== null,
            roles: required?.roles ?? null,
            handle: (context: SocketContext, data: unknown): unknown => method.call(instance, context, data),
        };
    }

    private endpointOf(scanned: ScannedClass, channel: SocketChannelDefinition): Endpoint {
        if (channel.endpoint !== null) {
            const endpoint: Endpoint | undefined = this.endpoints.get(channel.endpoint);
            this.ensure(endpoint !== undefined, scanned, `no @SocketEndpoint at "${channel.endpoint}"`);
            return endpoint as Endpoint;
        }
        this.ensure(this.endpoints.size > 0, scanned, 'a @SocketChannel needs a @SocketEndpoint');
        this.ensure(this.endpoints.size === 1, scanned, 'with several @SocketEndpoint classes a @SocketChannel must name its endpoint');

        return [...this.endpoints.values()][0];
    }

    private serve(endpoint: Endpoint, context: SocketRegistryContext): void {
        const socketServer: SocketServer = new SocketServer(context.server, endpoint.path, context.logger, context.authService, context.tokenBlacklist, {
            maxPayload: endpoint.hub.limits.maxFrameLength,
            beforeUpgrade: (request: http.IncomingMessage): Promise<SocketUpgradeDecision> => this.connect(endpoint, request),
            clientAddress: context.clientAddress,
        });
        socketServer.on('connection', (ws: ExtendedWebSocket, request: http.IncomingMessage, attributes: Record<string, unknown>): void => {
            this.attach(endpoint, ws, request, attributes, context.tokenBlacklist);
        });
        this.socketServers.push(socketServer);
        endpoint.hub.start();

        context.express.get(`${endpoint.path}/session`, (_request: express.Request, response: express.Response): void => {
            response.setHeader('Cache-Control', 'private, no-store');
            const userId: unknown = response.locals.userId;
            response.status(200).json({user: typeof userId === 'number' ? userId : null});
        });
        context.express.get(`${endpoint.path}/client/:file`, (request: express.Request, response: express.Response, next: express.NextFunction): void => {
            const file: ClientFile | undefined = this.loadClientFiles().get(String(request.params.file));
            if (file === undefined) {
                next();
                return;
            }
            response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            response.setHeader('Cache-Control', request.query.v === file.version ? 'public, max-age=31536000, immutable' : 'no-cache');
            response.status(200).send(file.content);
        });
    }

    private async connect(endpoint: Endpoint, request: http.IncomingMessage): Promise<SocketUpgradeDecision> {
        const refusal: SocketUpgradeDecision | null = SocketRegistry.authorize(endpoint.instance, 'connect', request);
        if (refusal !== null) {
            return refusal;
        }
        const attributes: object | null = await unguardedMethod(endpoint.instance, 'connect').call(endpoint.instance, request) as object | null;
        if (attributes === null) {
            return {accept: false, status: 403};
        }

        return {accept: true, context: Object.freeze({...attributes})};
    }

    private attach(endpoint: Endpoint, ws: ExtendedWebSocket, request: http.IncomingMessage, attributes: Record<string, unknown>, tokenBlacklist?: TokenBlacklistService): void {
        const auth: ExtendedRequest['auth'] = (request as ExtendedRequest).auth;
        const metadataUserId: unknown = auth?.metadata?.userId;
        const userId: number | null = typeof metadataUserId === 'number' ? metadataUserId : null;
        const role: string | null = typeof auth?.role === 'string' ? auth.role : null;
        const issuedAt: number = auth?.iat ?? 0;
        const stillValid: SocketSessionCheck | null = userId !== null && tokenBlacklist !== undefined
            ? (): boolean => !tokenBlacklist.isRevoked(userId, issuedAt)
            : null;
        const peer: SocketPeer = {
            get bufferedAmount(): number {
                return ws.bufferedAmount;
            },
            send: (frame: string): void => ws.send(frame),
            close: (code: number, reason: string): void => ws.close(code, reason),
        };
        const connection: SocketConnection = {id: ws.socketId, userId, attributes};
        const hubConnection: SocketHubConnection = endpoint.hub.attach(peer, connection, role, stillValid);
        const decoder: TextDecoder = new TextDecoder();

        ws.on('message', (data: unknown, isBinary: boolean): void => {
            hubConnection.receive(isBinary || !(data instanceof Uint8Array) ? '' : decoder.decode(data));
        });
        ws.on('close', (): void => hubConnection.closed());
    }

    /** Read once: the scripts ship with the framework and change only with a new build. */
    private loadClientFiles(): Map<string, ClientFile> {
        if (this.clientFiles === null) {
            this.clientFiles = new Map<string, ClientFile>(SocketRegistry.CLIENT_FILES.map((name: string): [string, ClientFile] => {
                const content: string = fs.readFileSync(path.join(SocketRegistry.CLIENT_DIRECTORY, name), 'utf8');
                return [name, {content, version: createHash('sha256').update(content).digest('hex').slice(0, 12)}];
            }));
        }

        return this.clientFiles;
    }

    private ensure(condition: boolean, scanned: ScannedClass, problem: string): void {
        if (!condition) {
            throw new Error(`Socket class "${scanned.className}" (${scanned.file}): ${problem}`);
        }
    }
}
