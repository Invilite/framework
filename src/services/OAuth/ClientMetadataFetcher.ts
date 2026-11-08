import {OAuthClient} from './OAuthTypes';
import {isAllowedRedirectUri} from './RedirectUriPolicy';
import {
    requestSafeHttps,
    SafeHttpsAddress,
    SafeHttpsFetcher,
    SafeHttpsRequest,
    SafeHttpsResponse,
    SafeHttpsTransport,
} from '../../utils/SafeHttpsFetch';

const METADATA_TIMEOUT_MS: number = 5_000;
const METADATA_MAX_BYTES: number = 64 * 1024;
const METADATA_CACHE_TTL_MS: number = 60 * 60 * 1000;
const METADATA_FAILURE_TTL_MS: number = 60 * 1000;
const METADATA_CACHE_MAX_ENTRIES: number = 1000;
const METADATA_CONTEXT: string = 'Client metadata';
const METADATA_TOO_LARGE: string = 'Client metadata document exceeds 64 KiB';
const METADATA_ALLOWED_PORTS: readonly string[] = ['443'];

export type ResolvedAddress = SafeHttpsAddress;

export type ClientMetadataResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type ClientMetadataRequest = SafeHttpsRequest;

export interface ClientMetadataResponse {
    statusCode: number;
    body: string;
}

export type ClientMetadataTransport = (request: ClientMetadataRequest) => Promise<ClientMetadataResponse>;

export interface ClientMetadataFetcherOptions {
    resolver?: ClientMetadataResolver;
    transport?: ClientMetadataTransport;
    now?: () => number;
}

interface CachedClient {
    client: OAuthClient;
    expiresAt: number;
}

interface CachedFailure {
    message: string;
    expiresAt: number;
}

/** HTTPS transport with a pinned DNS answer; exported so transport-level tests can exercise it directly. */
export async function requestMetadata(request: ClientMetadataRequest): Promise<ClientMetadataResponse> {
    const response: SafeHttpsResponse = await requestSafeHttps(
        {...request, accept: request.accept ?? 'application/json'},
        {
            timeout: `${METADATA_CONTEXT} request timed out`,
            tooLarge: METADATA_TOO_LARGE,
        },
    );

    return {
        statusCode: response.statusCode,
        body: response.body.toString('utf8'),
    };
}

/** Fetches an OAuth client metadata document, refusing non-public hosts and caching the result for one hour. */
export class ClientMetadataFetcher {
    private readonly fetcher: SafeHttpsFetcher;
    private readonly now: () => number;
    private readonly cache: Map<string, CachedClient> = new Map<string, CachedClient>();
    private readonly failures: Map<string, CachedFailure> = new Map<string, CachedFailure>();

    public constructor(options: ClientMetadataFetcherOptions = {}) {
        this.now = options.now ?? Date.now;

        const transport: ClientMetadataTransport | undefined = options.transport;
        const bufferTransport: SafeHttpsTransport | undefined = transport === undefined
            ? undefined
            : async (request: SafeHttpsRequest): Promise<SafeHttpsResponse> => {
                const response: ClientMetadataResponse = await transport(request);

                return {statusCode: response.statusCode, body: Buffer.from(response.body, 'utf8')};
            };

        this.fetcher = new SafeHttpsFetcher({
            context: METADATA_CONTEXT,
            resolver: options.resolver,
            transport: bufferTransport,
            sizeLimitMessage: (): string => METADATA_TOO_LARGE,
        });
    }

    public async fetch(clientIdUrl: string): Promise<OAuthClient> {
        const cached: CachedClient | undefined = this.cache.get(clientIdUrl);
        if (cached && cached.expiresAt > this.now()) {
            return cached.client;
        }
        const failure: CachedFailure | undefined = this.failures.get(clientIdUrl);
        if (failure && failure.expiresAt > this.now()) {
            throw new Error(failure.message);
        }

        try {
            const response: SafeHttpsResponse = await this.fetcher.fetch({
                url: clientIdUrl,
                allowedHosts: null,
                allowedPorts: METADATA_ALLOWED_PORTS,
                timeoutMs: METADATA_TIMEOUT_MS,
                maxBytes: METADATA_MAX_BYTES,
                accept: 'application/json',
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Client metadata request failed with status ${response.statusCode}`);
            }

            const client: OAuthClient = this.parseDocument(clientIdUrl, response.body.toString('utf8'));
            this.remember(clientIdUrl, client);

            return client;
        } catch (error: unknown) {
            this.rememberFailure(clientIdUrl, error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    private remember(clientIdUrl: string, client: OAuthClient): void {
        if (this.cache.size >= METADATA_CACHE_MAX_ENTRIES) {
            for (const [key, entry] of this.cache) {
                if (entry.expiresAt <= this.now()) {
                    this.cache.delete(key);
                }
            }
        }
        while (this.cache.size >= METADATA_CACHE_MAX_ENTRIES) {
            const oldest: string | undefined = this.cache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.cache.delete(oldest);
        }

        this.cache.set(clientIdUrl, {client, expiresAt: this.now() + METADATA_CACHE_TTL_MS});
    }

    private rememberFailure(clientIdUrl: string, message: string): void {
        this.pruneFailures();
        this.failures.set(clientIdUrl, {message, expiresAt: this.now() + METADATA_FAILURE_TTL_MS});
    }

    private pruneFailures(): void {
        for (const [key, entry] of this.failures) {
            if (entry.expiresAt <= this.now()) {
                this.failures.delete(key);
            }
        }
        while (this.failures.size >= METADATA_CACHE_MAX_ENTRIES) {
            const oldest: string | undefined = this.failures.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.failures.delete(oldest);
        }
    }

    private parseDocument(clientIdUrl: string, body: string): OAuthClient {
        let value: unknown;
        try {
            value = JSON.parse(body);
        } catch {
            throw new Error('Client metadata document is not valid JSON');
        }

        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error('Client metadata document must be a JSON object');
        }

        const document: Record<string, unknown> = value as Record<string, unknown>;
        if (document.client_id !== clientIdUrl) {
            throw new Error('Client metadata document client_id does not match its URL');
        }
        if (!Array.isArray(document.redirect_uris) || document.redirect_uris.length === 0) {
            throw new Error('Client metadata document must contain redirect_uris');
        }

        const redirectUris: string[] = [];
        for (const redirectUri of document.redirect_uris) {
            if (typeof redirectUri !== 'string' || !isAllowedRedirectUri(redirectUri)) {
                throw new Error('Client metadata document contains an invalid redirect_uri');
            }
            redirectUris.push(redirectUri);
        }

        if (document.client_name !== undefined && typeof document.client_name !== 'string') {
            throw new Error('Client metadata document client_name must be a string');
        }

        const providedName: string = typeof document.client_name === 'string' ? document.client_name.trim() : '';
        const clientName: string = providedName.length > 0 ? providedName : new URL(clientIdUrl).hostname;

        return {
            clientId: clientIdUrl,
            clientName,
            redirectUris,
            source: 'metadata_document',
        };
    }
}
