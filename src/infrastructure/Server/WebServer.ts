import path from "path";
import fs, {ReadStream} from "fs";
import http, {createServer} from "http";
import compression from "compression";
import cookieParser from "cookie-parser";
import express, {Express} from "express";
import {engine} from 'express-handlebars';
import Handlebars from "handlebars";
import {Class} from "../../utils/Class";
import {Env} from "../../utils/Env";
import {Logger} from "@invilite/logger";
import EventBus from "@invilite/eventbus";
import {RequestType} from "../../types/enums/RequestType";
import {InternalServerErrorConfig, NotFoundConfig, WebServerOptions} from "./WebServerOptions";
import {AbstractResponse} from "../../models/response/AbstractResponse";
import ApiResponse from "../../models/response/ApiResponse";
import {HttpStatusCodes} from "../../types/enums/HttpStatusCodes";
import {AbstractController} from "../../controllers/AbstractController";
import SocketServer from "./SocketServer";
import {SocketRegistry} from "./SocketRegistry";
import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {ExtendedRequest} from "../../models/ExtendedRequest";
import {AssetVersion, CurrentUrl, CanonicalUrl} from "./helpers";
import {AuthorizationMiddleware, LoggerMiddleware, CoreMiddleware} from "./http/middleware";
import {upgradeClientAddressOf} from "./http/middleware/CoreMiddleware";
import {AuthService} from "../../services/AuthService";
import TokenBlacklistService from "../../services/TokenBlacklistService";
import {RouteDefinition} from "../../types/interfaces/RouteDefinition";
import HttpError, {LoginRequiredError, NotFoundError, UnauthorizedError} from "../../errors/ApplicationError/HttpError";
import {REQUIRED_ROLES_METADATA, hasRequiredRoles, unguardedMethod} from "../../decorators/WebServer/RequiresAuth";

export default class WebServer {
    public static readonly DEFAULT_INTERNAL_ERROR_MESSAGE: string = 'Internal server error. Please try again later.';

    protected readonly logger: Logger;
    private readonly express: Express;
    private readonly server: http.Server;
    private readonly socketServers: Set<SocketServer> = new Set<SocketServer>();
    private readonly sockets: SocketRegistry = new SocketRegistry();
    private readonly listenerPaths: Set<string> = new Set<string>();
    private readonly internalServerErrorConfig?: InternalServerErrorConfig;
    private readonly internalErrorMessage: string;
    private readonly upgradeClientAddress: (request: http.IncomingMessage) => string | undefined;
    private readonly notFoundConfig: NotFoundConfig;
    private readonly loginPath: string;

    public constructor(logger: Logger, options: WebServerOptions, protected readonly authService: AuthService, protected readonly tokenBlacklist?: TokenBlacklistService) {
        const eventBus: EventBus = EventBus.getChannel();

        this.logger = logger;
        this.internalServerErrorConfig = options.internalServerError;
        this.internalErrorMessage = options.internalErrorMessage ?? WebServer.DEFAULT_INTERNAL_ERROR_MESSAGE;
        this.notFoundConfig = options.notFound ?? {};
        this.loginPath = options.loginPath ?? '/user/login';
        this.express = express();
        this.express.set('x-powered-by', false);
        this.express.set('trust proxy', options.trustProxy);
        this.express.set('etag', 'strong');
        this.upgradeClientAddress = (request: http.IncomingMessage): string | undefined => {
            return upgradeClientAddressOf(this.express, request, options.trustCloudflare ?? false);
        };

        this.server = createServer(this.express);

        this.server.on('error', (error: Error): void => {
            eventBus.emit('http.server.error', error);
            this.logger.emergency(`WebServer error:`, error);
        });

        this.express.use(cookieParser(Env.requireString('COOKIE_SECRET')));

        this.express.use(CoreMiddleware(eventBus, options.trustCloudflare ?? false));

        this.express.use(LoggerMiddleware(logger));

        // User-supplied observer middleware (e.g. HTTP request emitter). Registered
        // after Logger (so requestId is available) and before Authorization (so events
        // are emitted for every request regardless of auth outcome). WebServer stays
        // agnostic of what these middleware do - it just places them in the chain.
        if (options.middlewares) {
            for (const middleware of options.middlewares) {
                this.express.use(middleware);
            }
        }

        if (options.compression) {
            this.express.use(compression(options.compression));
        }

        // Static files go before Authorization: they need no identity, skip the JWT check, and a session
        // refresh must never put a Set-Cookie on a publicly cacheable asset.
        if (options.static) {
            if (Array.isArray(options.static)) {
                for (const staticDir of options.static) {
                    this.express.use(staticDir.path, express.static(staticDir.directory, staticDir.options));
                }
            } else {
                this.express.use(options.static.path, express.static(options.static.directory, options.static.options));
            }
        }

        this.express.use(AuthorizationMiddleware(authService, this.tokenBlacklist, options.session));

        if (options.template) {
            const helpers: any = {};
            const assetVersionDirectory: string | undefined = options.assetVersionDirectory
                ?? (options.static
                    ? (Array.isArray(options.static) ? options.static[0]?.directory : options.static.directory)
                    : undefined);
            if (assetVersionDirectory) {
                helpers.assetVersion = new AssetVersion(assetVersionDirectory).getHelper();
            }

            helpers.json = function (context: any) {
                return JSON.stringify(context, null, 2);
            };

            helpers.socketClient = (endpointPath: string, helperOptions: {data?: {root?: {userId?: unknown}}}): Handlebars.SafeString => {
                return new Handlebars.SafeString(this.sockets.scriptTag(endpointPath, helperOptions?.data?.root?.userId));
            };

            helpers.currentUrl = new CurrentUrl().getHelper();
            helpers.canonicalUrl = new CanonicalUrl().getHelper();

            if (options.template.helpers) {
                Object.assign(helpers, options.template.helpers);
            }

            this.express.engine('hbs', engine({
                extname: '.hbs',
                defaultLayout: 'main',
                layoutsDir: path.join(options.template.viewsPath, 'layouts'),
                partialsDir: path.join(options.template.viewsPath, 'partials'),
                helpers,
                // Bez preventIndent Handlebars dokleja wcięcie wywołania partiala do KAŻDEJ
                // linii jego wyniku - psuje prefill <textarea> (spacje na początku linii
                // treści = blok kodu w markdownie).
                compilerOptions: {preventIndent: true},
            }));

            this.express.engine('console', (filePath: string, data: any, callback): void => {
                fs.readFile(filePath, 'utf-8', (err, content: string) => {
                    if (err) return callback(err);

                    let rendered: string = content;
                    const templateData = data._locals || {};

                    Object.keys(templateData).forEach(key => {
                        const placeholder: RegExp = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
                        rendered = rendered.replace(placeholder, String(templateData[key]));
                    });

                    callback(null, rendered);
                });
            });

            this.express.set('view engine', 'hbs');
            this.express.set('views', options.template.viewsPath);
        }

        this.express.use(express.text());
        this.express.use(express.json());
        this.express.use(express.urlencoded({
            extended: true
        }));

        if (Array.isArray(options.controllersPath)) {
            for (const controllersPath of options.controllersPath) {
                this.registerControllers(controllersPath, options.controllerParams);
            }
        } else {
            this.registerControllers(options.controllersPath, options.controllerParams);
        }

        // Outside the per-file try/catch of the scan: a socket mistake stops the start instead of becoming a log line.
        this.sockets.build({
            server: this.server,
            express: this.express,
            logger: this.logger,
            authService: this.authService,
            tokenBlacklist: this.tokenBlacklist,
            options: options.socket,
            controllerParams: options.controllerParams,
            listenerPaths: this.listenerPaths,
            clientAddress: this.upgradeClientAddress,
        });

        // Terminal 404 handler — MUST be the last use() so it never shadows a real route.
        // Registered after static files and after all controllers + their 405 handlers.
        // Always registered: routes hidden from the caller answer with the same respondNotFound().
        this.registerNotFoundHandler();

        this.registerInternalServerErrorHandler(options.internalServerError);
    }

    public addMiddleware(middleware: any): this {
        this.express.use(middleware);

        return this;
    }

    /** Rejects when the port cannot be bound (e.g. EADDRINUSE), so the caller can exit instead of idling without a listener. */
    public listen(httpPort?: number): Promise<http.Server> {
        return new Promise((resolve, reject): void => {
            const failed: (error: Error) => void = (error: Error): void => reject(error);
            this.server.once('error', failed);
            const server: http.Server = this.server.listen(httpPort, () => {
                this.server.off('error', failed);
                server.on('close', () => {
                    this.logger.trace(`Web server stopped listening on port ${httpPort}`);
                });
                this.logger.notice(`Web server is listening on port ${httpPort}`);
                resolve(server);
            });
        });
    }

    public close(): Promise<void> {
        return new Promise((resolve): void => {
            this.logger.trace("Closing all web server connections ...");
            this.server.closeAllConnections();

            this.logger.trace("Closing all sockets ...");
            for (const socketServer of this.socketServers) {
                socketServer.closeAllConnections();
            }
            this.sockets.close();

            this.server.close((): void => {
                resolve();
            });
        });
    }

    public getExpress(): Express {
        return this.express;
    }

    private registerControllers(controllersPath: string, controllerParams?: unknown[]): void {
        const basePath: string = path.resolve(controllersPath);

        this.logger.trace(`Searching for controllers in "${basePath}" ...`);
        fs.readdirSync(controllersPath, {encoding: 'utf8', recursive: true}).filter((file: string) => {
            return file.endsWith("Controller.js") || file.endsWith("Controller.ts");
        }).forEach((file: string): void => {
            try {
                this.logger.trace(`Reading file "${path.join(basePath, file)}" ...`);
                const module = require(path.join(basePath, file));
                const modulePropertyNames: string[] = Object.keys(module);

                for (const propertyId in modulePropertyNames) {
                    const className: string | undefined = modulePropertyNames[propertyId];

                    // Reflect.getMetadata throws on a value that is not an object, which would drop the rest of the file.
                    if (typeof module[className] !== 'function') {
                        this.logger.trace(`Bypassing export "${className}" because it's not a class`);
                        continue;
                    }

                    if (this.sockets.collect(module[className], className, file)) {
                        this.logger.trace(`Socket class "${className}" will be checked after the scan`);
                        continue;
                    }

                    const isController: boolean = Reflect.getMetadata('IsController', module[className]) || false;

                    if (!isController) {
                        this.logger.trace(`Bypassing class "${className}" because it's not a controller (missing decorator)`);
                        continue;
                    }

                    if (!className || !Class.isInheritedFrom(module[className], AbstractController)) {
                        this.logger.trace(`Bypassing class "${className}" as it doesn't extend AbstractController`);
                        continue;
                    }

                    this.logger.trace(`Loading controller "${className}" ...`);
                    const baseUrl = Reflect.getMetadata('BaseUrl', module[className]) || "";
                    const registeredRoutes: RouteDefinition[] = Reflect.getMetadata('Routes', module[className]) ?? [];
                    const registeredWSHandlers: {path: string; function: string}[] = Reflect.getMetadata('WebSocketHandlers', module[className]) ?? [];

                    if (!Array.isArray(registeredRoutes) || (registeredRoutes.length === 0 && registeredWSHandlers.length === 0)) {
                        this.logger.warning(`Controller "${className}" has no routes to register thus can't be loaded`);
                        continue;
                    }

                    const controller: any & AbstractController = new module[className](controllerParams);

                    // Register web socket connections handlers; @RequiresAuth is checked on the upgrade request, the method gets (ws, request)
                    for (const handler of registeredWSHandlers) {
                        this.logger.trace(`WebSocket connection in path "${handler.path}" will be handled by ${className}.${handler.function}()`);
                        const webSocketServer: SocketServer = new SocketServer(this.server, handler.path, this.logger, this.authService, this.tokenBlacklist, {
                            beforeUpgrade: SocketRegistry.listenerDecision(controller, handler.function),
                            clientAddress: this.upgradeClientAddress,
                        });
                        webSocketServer.on('connection', unguardedMethod(controller, handler.function).bind(controller));
                        this.socketServers.add(webSocketServer);
                        this.listenerPaths.add(handler.path);
                    }

                    // Roles required by each route of a path; undefined = the route is not behind a role.
                    const controllerPaths: Map<string, (string[] | undefined)[]> = new Map<string, (string[] | undefined)[]>();

                    for (const route of registeredRoutes) {
                        if (typeof this.express[route.method] !== 'function') {
                            this.logger.emergency(`Method "${route.method}" is unknown to Express application, thus it can't be registered.`);
                            continue;
                        }

                        const urlPath: string = path.join('/', baseUrl, '/', route.path);
                        this.logger.trace(`Requests on "${route.method.toUpperCase()} ${urlPath}" will be executed by ${className}.${route.function}()`);

                        this.express[route.method](urlPath, this.requestHandler(controller, route));

                        const requiredRoles: string[] | undefined = Reflect.getMetadata(REQUIRED_ROLES_METADATA, controller, route.function);
                        controllerPaths.set(urlPath, [...(controllerPaths.get(urlPath) ?? []), requiredRoles]);
                    }

                    for (const [routePath, routeRoles] of controllerPaths) {
                        // A 405 would confirm a path whose every route is hidden, so a caller who could use none of them gets the 404.
                        const roleGates: string[][] | null = routeRoles.every((roles: string[] | undefined): boolean => roles !== undefined)
                            ? routeRoles as string[][]
                            : null;
                        this.express[RequestType.all](routePath, (request: express.Request, response: express.Response): void => {
                            if (response.headersSent) {
                                return;
                            }
                            const auth: ExtendedRequest['auth'] = (request as ExtendedRequest).auth;
                            if (roleGates && !roleGates.some((roles: string[]): boolean => hasRequiredRoles(auth, roles))) {
                                this.respondNotFound(request, response);
                                return;
                            }
                            this.applyDefaultCacheHeaders(response);
                            response.status(405).end("Method Not Allowed");
                        });
                    }
                }
            } catch(e) {
                this.logger.emergency("Registering controller error:", e);
            }
        });
    }

    private registerNotFoundHandler(): void {
        this.express.use((request: express.Request, response: express.Response): void => {
            this.respondNotFound(request, response);
        });
    }

    /** The one answer for a path that does not exist; a route hidden from the caller must be indistinguishable from it. */
    private respondNotFound(request: express.Request, response: express.Response): void {
        if (response.headersSent) return;

        // Strona 404 to HTML per-user (layout z menu zalogowania) — ta sama polityka
        // co @Render; poza requestHandler, więc nagłówek ustawiamy jawnie.
        if (!response.getHeader('Cache-Control')) {
            response.setHeader('Cache-Control', 'private, no-cache, no-transform');
        }

        if (this.notFoundConfig.handler) {
            this.notFoundConfig.handler(request, response);
            return;
        }

        if (this.notFoundConfig.template) {
            this.renderErrorPage(response, 404, this.notFoundConfig.template, this.notFoundConfig.data ?? {}, 'Not Found');
            return;
        }

        response.status(404).end('Not Found');
    }

    private registerInternalServerErrorHandler(config: InternalServerErrorConfig | undefined): void {
        // 4-arg signature = Express terminal error handler; catches next(err) from
        // body-parser, middleware and render errors.
        this.express.use((error: unknown, request: express.Request, response: express.Response, next: express.NextFunction): void => {
            if (response.headersSent) {
                next(error);
                return;
            }

            const clientErrorStatus: number | null = WebServer.clientErrorStatusOf(error);
            if (clientErrorStatus !== null) {
                const body: string | undefined = error instanceof HttpError ? error.getResponse() : undefined;
                this.applyDefaultCacheHeaders(response);
                response.status(clientErrorStatus).type('text/plain').end(body ?? http.STATUS_CODES[clientErrorStatus] ?? 'Bad Request');
                return;
            }

            this.logger.error(error);
            this.respondError(config, error, request, response);
        });
    }

    private static clientErrorStatusOf(error: unknown): number | null {
        if (error instanceof HttpError) {
            const httpCode: number = error.getHttpCode();
            return httpCode >= 400 && httpCode < 500 ? httpCode : null;
        }
        if (typeof error !== 'object' || error === null) {
            return null;
        }
        const {status, expose}: {status?: unknown; expose?: unknown} = error as {status?: unknown; expose?: unknown};

        return expose === true && typeof status === 'number' && status >= 400 && status < 500 ? status : null;
    }

    /**
     * Jedyny mechanizm odpowiedzi 500 — bez szczegółów błędu (tylko requestId do
     * korelacji z logami). SSR vs JSON rozróżniane po fladze renderRoute ustawianej
     * przez dekorator @Render.
     */
    private respondError(config: InternalServerErrorConfig | undefined, error: unknown, request: express.Request, response: express.Response): void {
        if (response.headersSent) {
            // Odpowiedź już poszła (kontroler sam zamknął response przed rzuceniem
            // błędu) — end() po finish to ERR_STREAM_WRITE_AFTER_END.
            this.logger.error(error);
            return;
        }

        if (config?.handler) {
            config.handler(error, request, response);
            return;
        }

        if (config?.template && (request as ExtendedRequest).renderRoute) {
            if (!response.getHeader('Cache-Control')) {
                response.setHeader('Cache-Control', 'private, no-cache, no-transform');
            }

            this.renderErrorPage(response, 500, config.template, {
                ...config.data,
                requestId: response.locals.requestId,
                robotsMeta: 'noindex, follow',
            }, this.internalErrorMessage);
            return;
        }

        this.applyDefaultCacheHeaders(response);

        const apiResponse: ApiResponse = new ApiResponse(1, response.locals.requestId);
        apiResponse.addError({
            message: this.internalErrorMessage,
            details: null,
        }).setSuccess(false).setStatusCode(HttpStatusCodes.INTERNAL_SERVER_ERROR);

        response.status(500).end(apiResponse.getData(), 'utf-8');
    }

    /**
     * Renders an error page with a callback: without one a failing template (missing file, broken
     * layout or helper) goes to Express's default final handler, which outside NODE_ENV=production
     * sends the stack trace to the visitor. Here the failure is logged and a plain-text body goes out.
     */
    private renderErrorPage(response: express.Response, status: number, template: string, data: object, fallback: string): void {
        response.status(status).render(template, data, (renderError: Error | null, html?: string): void => {
            if (!renderError) {
                response.send(html);
                return;
            }
            this.logger.error(renderError);
            if (response.headersSent) {
                return;
            }
            response.status(status).type('text/plain; charset=utf-8').end(fallback);
        });
    }

    private requestHandler(controller: any, route: RouteDefinition): (request: express.Request, response: express.Response) => Promise<any> {
        return async (request: express.Request, response: express.Response) => {
            const extendedRequest: ExtendedRequest = (request as ExtendedRequest);
            let logger: AbstractLogger = this.logger;
            if (extendedRequest.logger) {
                logger = extendedRequest.logger;
            }

            try {
                const data: unknown = await controller[route.function](request, response);

                if (response.closed) {
                    return;
                }

                // @Render routes respond via response.render() inside the decorator
                // and return undefined — the response is already sent.
                if (!data && (request as ExtendedRequest).renderRoute) {
                    return;
                }

                // Plain route returning undefined = 204 No Content. Controllers
                // that self-respond (response.redirect/end) also land here — the
                // writableEnded guard keeps the second end() a silent no-op.
                // selfResponding marks a controller that is still piping the body
                // asynchronously: writableEnded is false at this point, yet the
                // response is owned by the controller and must not be coerced.
                if (!data) {
                    if (!response.writableEnded && !extendedRequest.selfResponding) {
                        this.applyDefaultCacheHeaders(response);
                        response.status(204).end();
                    }
                    return;
                }

                this.applyDefaultCacheHeaders(response);

                if (typeof data === 'string' || (typeof data === 'object' && data instanceof Buffer)) {
                    if (!response.getHeader('Content-Type')) {
                        response.setHeader('Content-Type', 'text/plain');
                    }

                    return response.end(data, 'utf-8');
                }

                if (typeof data === 'object' && data instanceof AbstractResponse) {
                    const headers: { [name: string]: string | number | readonly string[]; } = data.getHeaders();
                    for (const headerName in headers) {
                        response.setHeader(headerName, headers[headerName]);
                    }
                    return response.status(data.getStatusCode()).end(data.getData(), 'utf-8');
                }

                if (typeof data === 'object' && data instanceof HttpError) {
                    logger.error(data.message);
                    return response.status(data.getHttpCode()).end(data.getResponse());
                }

                if (typeof data === 'object' && data instanceof Error) {
                    logger.error(data.message);
                    return this.respondError(this.internalServerErrorConfig, data, request, response);
                }

                if (typeof data === 'object' && data instanceof ReadStream) {
                    data.once('error', (error: Error): void => {
                        logger.error(error);
                        this.respondError(this.internalServerErrorConfig, error, request, response);
                    });
                    data.once('close', (): void => {
                        response.end();
                    });
                    return data.pipe(response);
                }

                if (typeof data === 'object' || Array.isArray(data)) {
                    if (!response.getHeader('Content-Type')) {
                        response.setHeader('Content-Type', 'application/json');
                    }

                    return response.end(JSON.stringify(data), 'utf-8');
                }

                if (route.method == RequestType.head) {
                    return response.end();
                }

                logger.error(Error("Unknown response from controller"));
                return this.respondError(this.internalServerErrorConfig, new Error("Unknown response from controller"), request, response);
            } catch (e) {
                // A thrown NotFoundError means "answer as if this route did not exist" (e.g. a role the caller lacks).
                if (e instanceof NotFoundError) {
                    return this.respondNotFound(request, response);
                }

                logger.error(e);
                if (e instanceof HttpError) {
                    this.applyDefaultCacheHeaders(response);
                    if (e instanceof LoginRequiredError) {
                        return response.redirect(`${this.loginPath}?redirect=${encodeURIComponent(e.getReturnTo())}`);
                    }
                    if (e instanceof UnauthorizedError) {
                        const redirect: string | undefined = e.getRedirect();
                        if (redirect) {
                            return response.redirect(redirect);
                        }
                    }
                    return response.status(e.getHttpCode()).end(e.getResponse());
                }

                return this.respondError(this.internalServerErrorConfig, e, request, response);
            }
        };
    }

    /**
     * Domyślna polityka cache dla odpowiedzi API (JSON, błędy, strumienie) — wszystko,
     * co nie jest stroną HTML renderowaną przez @Render. `no-store` = żaden cache
     * (przeglądarka, proxy, CDN) nie może zapisać odpowiedzi: treści API są per-user,
     * a klucz cache CDN to sam URL — zapisana odpowiedź jednego użytkownika trafiłaby
     * do innych. Nie nadpisujemy nagłówka ustawionego jawnie przez kontroler (np. sitemap).
     */
    private applyDefaultCacheHeaders(response: express.Response): void {
        if (response.headersSent || response.getHeader('Cache-Control')) {
            return;
        }

        response.setHeader('Cache-Control', 'private, no-store');
    }
}
