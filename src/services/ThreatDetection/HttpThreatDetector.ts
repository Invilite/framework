import EventBus from '@invilite/eventbus';
import HttpThreatCategory from '../../types/enums/HttpThreatCategory';
import HttpRequestCompletedEvent from '../../types/interfaces/HttpRequestCompletedEvent';
import HttpThreatDetectedEvent, {
    HTTP_THREAT_DETECTED_EVENT,
    HttpThreat,
    HttpThreatInput,
} from '../../types/interfaces/HttpThreatDetectedEvent';
import {AbstractLogger} from '../../types/interfaces/AbstractLogger';
import {InternalAddress} from '../../utils/InternalAddress';
import {SecretPaths} from '../../utils/SecretPaths';
import {RepeatThrottle} from '../../utils/RepeatThrottle';
import {HttpThreatRules, HttpThreatRequestText} from './HttpThreatRules';
import {
    HttpThreatText,
    MAX_CLIENT_ADDRESS_LENGTH,
    MAX_HEADER_TEXT_LENGTH,
    MAX_URL_TEXT_LENGTH,
} from './HttpThreatText';
import {UserAgentConsistencyTracker} from './UserAgentConsistencyTracker';

export interface HttpThreatDetectorOptions {
    allowedOrigin: string;
    allowedHosts: string[];
    disabledCategories?: HttpThreatCategory[];
    now?: () => number;
}

const COMPLETED_REQUEST_EVENT: string = 'http.request.completed';

function readHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const value: string | string[] | undefined = headers[name];

    if (Array.isArray(value)) {
        return value[0];
    }

    return value;
}

export class HttpThreatDetector {
    private readonly allowedOrigin: string;
    private readonly allowedHosts: ReadonlySet<string>;
    private readonly disabledCategories: ReadonlySet<HttpThreatCategory>;
    private readonly logger: AbstractLogger;
    private readonly eventBus: EventBus;
    private readonly userAgentTracker: UserAgentConsistencyTracker;
    private readonly errorThrottle: RepeatThrottle = new RepeatThrottle(600_000);
    private readonly completedListener: (event: HttpRequestCompletedEvent) => void;
    private started: boolean = false;

    public constructor(
        options: HttpThreatDetectorOptions,
        logger: AbstractLogger,
        eventBus: EventBus = EventBus.getChannel(),
    ) {
        this.allowedOrigin = new URL(options.allowedOrigin).origin;
        this.allowedHosts = new Set<string>(
            options.allowedHosts.map((host: string): string => HttpThreatRules.hostWithoutPort(host)),
        );
        this.disabledCategories = new Set<HttpThreatCategory>(options.disabledCategories ?? []);
        this.logger = logger;
        this.eventBus = eventBus;
        this.userAgentTracker = new UserAgentConsistencyTracker(options.now ?? Date.now);
        this.completedListener = (event: HttpRequestCompletedEvent): void => {
            this.handleCompletedRequest(event);
        };
    }

    public start(): void {
        if (this.started) {
            return;
        }

        this.eventBus.on(COMPLETED_REQUEST_EVENT, this.completedListener);
        this.started = true;
    }

    public stop(): void {
        if (this.started === false) {
            return;
        }

        this.eventBus.off(COMPLETED_REQUEST_EVENT, this.completedListener);
        this.started = false;
    }

    public inspect(event: HttpRequestCompletedEvent): HttpThreatDetectedEvent | null {
        const path: string = HttpThreatText.truncate(
            HttpThreatText.decode(event.path, false),
            MAX_URL_TEXT_LENGTH,
        );
        const query: string = HttpThreatText.truncate(
            HttpThreatText.decode(event.url.search.slice(1), true),
            MAX_URL_TEXT_LENGTH,
        );
        const rawUserAgent: string | undefined = readHeader(event.headers, 'user-agent');
        const rawReferer: string | undefined = readHeader(event.headers, 'referer');
        const rawHost: string | undefined = readHeader(event.headers, 'host');
        const rawClientHints: string | undefined = readHeader(event.headers, 'sec-ch-ua');
        const userAgent: string = HttpThreatText.truncate(rawUserAgent ?? '', MAX_HEADER_TEXT_LENGTH);
        const referer: string = HttpThreatText.truncate(rawReferer ?? '', MAX_HEADER_TEXT_LENGTH);
        const clientHints: string = HttpThreatText.truncate(rawClientHints ?? '', MAX_HEADER_TEXT_LENGTH);
        const clientAddress: string | undefined = event.clientAddress === undefined
            ? undefined
            : HttpThreatText.truncate(event.clientAddress, MAX_CLIENT_ADDRESS_LENGTH);
        const text: HttpThreatRequestText = {
            path: path,
            query: query,
            userAgent: userAgent,
            referer: referer,
            method: event.method.toUpperCase(),
            host: HttpThreatRules.hostWithoutPort(rawHost ?? ''),
            origin: event.url.origin,
            clientHints: clientHints,
            fromInternalNetwork: clientAddress === undefined ? false : InternalAddress.isInternal(clientAddress),
        };
        const threats: HttpThreat[] = HttpThreatRules.match(text, {
            allowedOrigin: this.allowedOrigin,
            allowedHosts: this.allowedHosts,
            disabledCategories: this.disabledCategories,
        });
        let claimedUserAgent: string | null = null;

        if (
            this.disabledCategories.has(HttpThreatCategory.UserAgentSpoofing) === false
            && clientAddress !== undefined
            && clientAddress !== ''
            && userAgent !== ''
        ) {
            claimedUserAgent = this.userAgentTracker.observe(clientAddress, userAgent);

            if (claimedUserAgent !== null) {
                threats.push({
                    category: HttpThreatCategory.UserAgentSpoofing,
                    rule: 'spoofing-automation-after-browser',
                    input: 'user-agent',
                });
            }
        }

        if (threats.length === 0) {
            return null;
        }

        const detected: HttpThreatDetectedEvent = {
            requestId: event.requestId,
            clientAddress: clientAddress === undefined
                ? undefined
                : HttpThreatText.sanitize(clientAddress),
            method: event.method,
            host: rawHost === undefined
                ? undefined
                : HttpThreatText.sanitize(HttpThreatText.truncate(rawHost, MAX_HEADER_TEXT_LENGTH)),
            path: HttpThreatText.sanitize(SecretPaths.redact(path)),
            query: HttpThreatText.sanitize(SecretPaths.redact(query)),
            userAgent: rawUserAgent === undefined ? undefined : HttpThreatText.sanitize(userAgent),
            statusCode: event.statusCode,
            aborted: event.processingTime === null,
            threats: threats,
        };

        if (threats.some((threat: HttpThreat): boolean => threat.input === 'origin')) {
            detected.targetOrigin = event.url.origin;
        }

        if (claimedUserAgent !== null) {
            detected.claimedUserAgent = HttpThreatText.sanitize(claimedUserAgent);
        }

        if (threats.some((threat: HttpThreat): boolean => threat.input === 'client-hints')) {
            detected.clientHints = HttpThreatText.sanitize(clientHints);
        }

        if (threats.some((threat: HttpThreat): boolean => threat.input === 'referer')) {
            detected.referer = HttpThreatText.sanitize(SecretPaths.redact(referer));
        }

        return detected;
    }

    public static describe(event: HttpThreatDetectedEvent): string {
        const categories: string = Array.from(
            new Set<HttpThreatCategory>(event.threats.map((threat: HttpThreat): HttpThreatCategory => threat.category)),
        ).join(',');
        const rules: string = event.threats
            .map((threat: HttpThreat): string => `${threat.rule}/${threat.input}`)
            .join(', ');
        const address: string = event.clientAddress ?? '-';
        const target: string = event.query === '' ? event.path : `${event.path}?${event.query}`;
        const status: string = event.aborted ? 'aborted' : String(event.statusCode);
        const inputExists = (input: HttpThreatInput): boolean => {
            return event.threats.some((threat: HttpThreat): boolean => threat.input === input);
        };
        const details: string[] = [];

        if (inputExists('host')) {
            details.push(`host=${event.host ?? ''}`);
        }

        if (inputExists('origin')) {
            details.push(`origin=${event.targetOrigin ?? ''}`);
        }

        if (inputExists('user-agent')) {
            details.push(`ua="${event.userAgent ?? ''}"`);
        }

        if (event.claimedUserAgent !== undefined) {
            details.push(`claimed="${event.claimedUserAgent}"`);
        }

        if (inputExists('client-hints')) {
            details.push(`ch="${event.clientHints ?? ''}"`);
        }

        if (inputExists('referer')) {
            details.push(`referer="${event.referer ?? ''}"`);
        }

        const detailsText: string = details.length === 0 ? '' : ' ' + details.join(' ');

        return `HTTP threat ${categories} from ${address}: ${event.method} ${target} -> ${status} ` +
            `[${rules}]${detailsText} (request ${event.requestId})`;
    }

    private handleCompletedRequest(event: HttpRequestCompletedEvent): void {
        try {
            const detected: HttpThreatDetectedEvent | null = this.inspect(event);

            if (detected !== null) {
                this.eventBus.emit(HTTP_THREAT_DETECTED_EVENT, detected);
            }
        } catch (error: unknown) {
            const suppressedCount: number | null = this.errorThrottle.claim('inspect');

            if (suppressedCount !== null) {
                const suffix: string = suppressedCount > 0
                    ? ` (${suppressedCount} similar errors suppressed)`
                    : '';
                this.logger.error(`[HttpThreatDetector] inspection failed${suffix}`, error);
            }
        }
    }
}

export default HttpThreatDetector;
