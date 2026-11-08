import * as Sentry from "@sentry/node";
import type {Breadcrumb, ErrorEvent, NodeOptions} from "@sentry/node";
import {SecretPaths} from "../../utils/SecretPaths";

type Integration = Exclude<NonNullable<NodeOptions['defaultIntegrations']>, false>[number];

export interface ErrorTrackingOptions {
    /** Sentry-protocol DSN (Sentry, GlitchTip). */
    dsn: string;
    environment: string;
    release?: string;
    /** Share of HTTP transactions sent as performance traces; 0 sends errors only. */
    tracesSampleRate: number;
}

/** What `ErrorTrackingTransport` needs from the tracker - the seam replaced in tests. */
export interface ErrorTrackingClient {
    captureException(error: Error, context: ErrorTrackingContext): void;
    captureMessage(message: string, context: ErrorTrackingContext): void;
}

export type ErrorTrackingLevel = 'fatal' | 'error';

export interface ErrorTrackingContext {
    level: ErrorTrackingLevel;
    fingerprint: string[] | null;
    tags: Record<string, string>;
    extra: Record<string, unknown>;
}

/** Request headers worth keeping on an event; everything else (cookies, authorization, tokens) is dropped. */
const ALLOWED_REQUEST_HEADERS: readonly string[] = ['user-agent', 'accept', 'accept-language', 'content-type', 'content-length', 'host'];
const ALLOWED_REQUEST_HEADER_SET: ReadonlySet<string> = new Set<string>(ALLOWED_REQUEST_HEADERS);

/**
 * Integrations removed from the SDK defaults:
 * - OnUnhandledRejection: the application logs rejections itself and the logger transport reports them,
 * - ProcessSession: session tracking (GlitchTip ignores sessions),
 * - Console: every console line becomes a breadcrumb, and debug logs carry SQL parameter values.
 */
const REMOVED_DEFAULT_INTEGRATIONS: ReadonlySet<string> = new Set<string>(['OnUnhandledRejection', 'ProcessSession', 'Console']);

export default class ErrorTracking implements ErrorTrackingClient {

    public static initialize(options: ErrorTrackingOptions): ErrorTracking {
        Sentry.init({
            dsn: options.dsn,
            environment: options.environment,
            release: options.release,
            tracesSampleRate: options.tracesSampleRate,
            // The SDK collects everything by default; send no user data, cookies, bodies, query strings or AI prompts.
            dataCollection: {
                userInfo: false,
                cookies: false,
                httpHeaders: {request: {allow: [...ALLOWED_REQUEST_HEADERS]}, response: false},
                httpBodies: [],
                urlQueryParams: false,
                graphQL: {document: false, variables: false},
                genAI: {inputs: false, outputs: false},
            },
            integrations: (defaults: Integration[]): Integration[] => [
                ...defaults.filter((integration: Integration): boolean => !REMOVED_DEFAULT_INTEGRATIONS.has(integration.name)),
                Sentry.httpIntegration({sessions: false}),
            ],
            beforeSend: (event: ErrorEvent): ErrorEvent => ErrorTracking.scrubEvent(event),
            beforeBreadcrumb: (breadcrumb: Breadcrumb): Breadcrumb => ErrorTracking.scrubBreadcrumb(breadcrumb),
        });

        return new ErrorTracking();
    }

    /** Drops request data that may identify a user or carry credentials. */
    public static scrubEvent(event: ErrorEvent): ErrorEvent {
        if (event.request) {
            delete event.request.cookies;
            delete event.request.data;
            delete event.request.query_string;
            if (event.request.url) {
                event.request.url = SecretPaths.redact(ErrorTracking.stripQuery(event.request.url));
            }
            if (event.request.headers) {
                const keptHeaders: Record<string, string> = {};
                for (const [name, value] of Object.entries(event.request.headers)) {
                    if (ALLOWED_REQUEST_HEADER_SET.has(name.toLowerCase())) {
                        keptHeaders[name] = value;
                    }
                }
                event.request.headers = keptHeaders;
            }
        }
        delete event.user;

        if (typeof event.message === 'string') {
            event.message = ErrorTracking.scrubText(event.message);
        }
        for (const exception of event.exception?.values ?? []) {
            if (typeof exception.value === 'string') {
                exception.value = ErrorTracking.scrubText(exception.value);
            }
        }
        for (const [key, value] of Object.entries(event.extra ?? {})) {
            if (typeof value === 'string' && event.extra) {
                event.extra[key] = ErrorTracking.scrubText(value);
            }
        }

        return event;
    }

    /** Masks row values that PostgreSQL puts into error details (`Key (email)=(…)`, `Failing row contains (…)`). */
    public static scrubText(text: string): string {
        return text
            .replace(/(Key \([^)]*\))=\([^\n]*?\)( already exists| is not present| conflicts)/g, '$1=(…)$2')
            .replace(/Failing row contains \([^\n]*\)/g, 'Failing row contains (…)');
    }

    public static scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
        const url: unknown = breadcrumb.data?.url;
        if (typeof url === 'string' && breadcrumb.data) {
            breadcrumb.data.url = SecretPaths.redact(ErrorTracking.stripQuery(url));
        }

        return breadcrumb;
    }

    public static stripQuery(url: string): string {
        const queryStart: number = url.search(/[?#]/);

        return queryStart === -1 ? url : url.slice(0, queryStart);
    }

    public captureException(error: Error, context: ErrorTrackingContext): void {
        Sentry.withScope((scope: Sentry.Scope): void => {
            ErrorTracking.applyContext(scope, context);
            Sentry.captureException(error);
        });
    }

    public captureMessage(message: string, context: ErrorTrackingContext): void {
        Sentry.withScope((scope: Sentry.Scope): void => {
            ErrorTracking.applyContext(scope, context);
            Sentry.captureMessage(message, context.level);
        });
    }

    /** Sends queued events before the process exits. */
    public flush(timeoutMs: number): Promise<boolean> {
        return Sentry.flush(timeoutMs);
    }

    private static applyContext(scope: Sentry.Scope, context: ErrorTrackingContext): void {
        scope.setLevel(context.level);
        if (context.fingerprint !== null) {
            scope.setFingerprint(context.fingerprint);
        }
        scope.setTags(context.tags);
        scope.setExtras(context.extra);
    }
}
