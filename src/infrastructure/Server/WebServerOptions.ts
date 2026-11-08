import compression from "compression";
import {Request, Response} from "express";
import {ServeStaticOptions} from "serve-static";
import {SessionService} from "../../services/Session/SessionService";
import {SocketPublisher} from "../../services/Socket/SocketPublisher";
import {SocketLimits} from "./socket/SocketHub";

/** Required as soon as a controllers directory has a @SocketEndpoint. */
export interface WebServerSocketOptions {
    /** The one in the ServiceContainer: the hubs take its broker and subject prefix, so they cannot drift apart. */
    publisher: SocketPublisher;
    limits?: Partial<SocketLimits>;
}

export interface ServeStatic {
    path: string;
    directory: string;
    options?: ServeStaticOptions;
}

export interface NotFoundConfig {
    /** Template name (without extension) to render via response.render(). Requires options.template to be set. */
    template?: string;
    data?: Record<string, unknown>;
    /** Full custom handler. Used when no template engine is configured, or when the caller wants total control. Wins over `template` if both set. */
    handler?: (request: Request, response: Response) => void;
}

export interface InternalServerErrorConfig {
    /** Template name (without extension) to render via response.render(). Requires the view engine (options.template) to be configured. */
    template?: string;
    /** Data passed to response.render(). Static object; requestId and robotsMeta are added by the mechanism. */
    data?: Record<string, unknown>;
    /** Full custom handler. Used when no template engine is configured, or when the caller wants total control. Wins over `template` if both set. */
    handler?: (error: unknown, request: Request, response: Response) => void;
}

/**
 * Express `trust proxy`: which hops in front of the app may name the client in X-Forwarded-For - a hop count, or
 * addresses/subnets ('loopback', '10.0.0.0/8'). `true` trusts every hop, so the client can name any address; use it
 * only when the proxy in front overwrites the header instead of appending to it.
 */
export type TrustProxy = boolean | number | string | string[];

export interface WebServerOptions {
    /**
     * Required, with no default: the right value depends on what stands in front of each service, and a silent
     * default either trusts a client-supplied address (rate limits, sessions) or reads every client as the proxy.
     */
    trustProxy: TrustProxy;
    /**
     * Take the client address from CF-Connecting-IP. Only for a server reachable solely through Cloudflare -
     * anyone else can send the header and pick their own address.
     */
    trustCloudflare?: boolean;
    /** Where a guest is sent from a @RequiresAuth() page, with `?redirect=<the page>`. Default `/user/login`. */
    loginPath?: string;
    controllersPath: string | string[];
    controllerParams?: unknown[];
    compression?: { enable: boolean; } & compression.CompressionOptions
    static?: ServeStatic[] | ServeStatic;
    /**
     * Katalog dla helpera `assetVersion`. Gdy podany, wygrywa z `static[0].directory` -
     * pozwala rejestrować dodatkowe mounty (np. cache'owaną paczkę assetów) przed katalogiem głównym.
     */
    assetVersionDirectory?: string;
    template?: false | {
        viewsPath: string;
        helpers?: Record<string, (...args: any[]) => any>;
    };
    middlewares?: any[];
    /** Session lifecycle; with it AuthorizationMiddleware refreshes an expired or missing access token in the same request. */
    session?: SessionService;
    notFound?: NotFoundConfig;
    internalServerError?: InternalServerErrorConfig;
    /** Plain-text message for a 500 when no handler or template answers. Default: WebServer.DEFAULT_INTERNAL_ERROR_MESSAGE. */
    internalErrorMessage?: string;
    socket?: WebServerSocketOptions;
}
