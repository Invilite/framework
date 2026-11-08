import EventBus from '@invilite/eventbus';
import {AbstractLogger} from '../../src/types/interfaces/AbstractLogger';
import HttpThreatCategory from '../../src/types/enums/HttpThreatCategory';
import HttpRequestCompletedEvent from '../../src/types/interfaces/HttpRequestCompletedEvent';
import HttpThreatDetectedEvent, {HTTP_THREAT_DETECTED_EVENT} from '../../src/types/interfaces/HttpThreatDetectedEvent';
import {HttpThreatRules} from '../../src/services/ThreatDetection/HttpThreatRules';
import {HttpThreatDetector} from '../../src/services/ThreatDetection/HttpThreatDetector';
import {UserAgentConsistencyTracker} from '../../src/services/ThreatDetection/UserAgentConsistencyTracker';
import {
    MAX_CLIENT_ADDRESS_LENGTH,
    MAX_HEADER_TEXT_LENGTH,
} from '../../src/services/ThreatDetection/HttpThreatText';
import {SecretPaths} from '../../src/utils/SecretPaths';
import {
    CHROME_USER_AGENT,
    HEADLESS_CHROME_USER_AGENT,
    IPHONE_SAFARI_USER_AGENT,
} from './fixtures/http-threat-requests';

const ALLOWED_ORIGIN: string = 'https://example.com';
const ATTACK_PATH_AND_QUERY: string =
    '/articles/tag/bw?page=1&limit=48%20UNION%20ALL%20SELECT%20NULL--';

function buildLogger(): AbstractLogger & {warning: jest.Mock; error: jest.Mock} {
    return {
        trace: (): void => {},
        debug: (): void => {},
        info: (): void => {},
        notice: (): void => {},
        warning: jest.fn(),
        error: jest.fn(),
        critical: (): void => {},
        alert: (): void => {},
        emergency: (): void => {},
    };
}

function completedEvent(
    pathAndQuery: string,
    overrides: Partial<HttpRequestCompletedEvent> = {},
): HttpRequestCompletedEvent {
    const url: URL = new URL(pathAndQuery, ALLOWED_ORIGIN);

    return {
        method: 'GET',
        path: url.pathname,
        url,
        requestId: 'Ab12Cd34Ef56',
        headers: {
            host: 'example.com',
            'user-agent': 'Mozilla/5.0',
            cookie: 'accessToken=secret',
        },
        cookies: {accessToken: 'secret'},
        signedCookies: {},
        statusCode: 200,
        statusMessage: 'OK',
        requestTime: 1,
        processingTime: 1,
        locals: {},
        ...overrides,
    };
}

function buildDetector(
    logger: AbstractLogger,
    eventBus: EventBus,
    now?: () => number,
): HttpThreatDetector {
    return new HttpThreatDetector({
        allowedOrigin: ALLOWED_ORIGIN,
        allowedHosts: ['example.com', 'www.example.com'],
        now,
    }, logger, eventBus);
}

function headersWithUserAgent(userAgent: string, extraHeaders: Record<string, string | string[]> = {}): Record<string, string | string[]> {
    return {'host': 'example.com', 'user-agent': userAgent, ...extraHeaders};
}

describe('HttpThreatDetector', () => {
    let eventBus: EventBus;
    let logger: ReturnType<typeof buildLogger>;
    let detector: HttpThreatDetector;
    let detectedEvents: HttpThreatDetectedEvent[];

    beforeEach((): void => {
        eventBus = new EventBus();
        logger = buildLogger();
        detector = buildDetector(logger, eventBus);
        detectedEvents = [];
        eventBus.on(HTTP_THREAT_DETECTED_EVENT, (event: HttpThreatDetectedEvent): void => {
            detectedEvents.push(event);
        });
    });

    afterEach((): void => {
        detector.stop();
        jest.restoreAllMocks();
    });

    it('emituje jedno zdarzenie dla ataku', (): void => {
        detector.start();

        eventBus.emit('http.request.completed', completedEvent(ATTACK_PATH_AND_QUERY));

        expect(detectedEvents).toHaveLength(1);
        const detected: HttpThreatDetectedEvent = detectedEvents[0];
        expect(detected.threats).toContainEqual({
            category: HttpThreatCategory.SqlInjection,
            rule: 'sql-union-select',
            input: 'query',
        });
        expect(detected.statusCode).toBe(200);
        expect(detected.requestId).toBe('Ab12Cd34Ef56');
    });

    it('nie emituje dla legalnego żądania', (): void => {
        detector.start();

        eventBus.emit('http.request.completed', completedEvent('/articles/tag/bw?page=1&limit=48'));

        expect(detectedEvents).toHaveLength(0);
    });

    it('nie słucha zdarzenia received', (): void => {
        detector.start();

        eventBus.emit('http.request.received', completedEvent(ATTACK_PATH_AND_QUERY));

        expect(detectedEvents).toHaveLength(0);
    });

    it('payload nie zawiera sekretów, a ścieżka jest zamaskowana', (): void => {
        SecretPaths.register(/\/(s|d)\/[A-Za-z0-9_-]{20,}/g, '/$1/***');

        const detected: HttpThreatDetectedEvent | null = detector.inspect(
            completedEvent('/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/.env'),
        );

        expect(detected).not.toBeNull();
        expect(Object.keys(detected as HttpThreatDetectedEvent).sort()).toEqual([
            'aborted',
            'clientAddress',
            'host',
            'method',
            'path',
            'query',
            'requestId',
            'statusCode',
            'threats',
            'userAgent',
        ]);
        expect(JSON.stringify(detected)).not.toContain('accessToken=secret');
        expect(detected?.path).toBe('/s/***/.env');
    });

    it('ucina nagłówek Host w payloadzie', (): void => {
        const detected: HttpThreatDetectedEvent | null = detector.inspect(completedEvent('/.env', {
            headers: {'host': 'a'.repeat(2000), 'user-agent': 'Mozilla/5.0'},
        }));

        expect(detected).not.toBeNull();
        expect(detected?.host).toHaveLength(MAX_HEADER_TEXT_LENGTH);
    });

    it('ucina i oczyszcza adres klienta w payloadzie', (): void => {
        const detected: HttpThreatDetectedEvent | null = detector.inspect(completedEvent('/.env', {
            clientAddress: 'aaaaa\x01' + 'a'.repeat(1994),
        }));

        expect(detected).not.toBeNull();
        expect(detected?.clientAddress).toBe('aaaaa\\x01' + 'a'.repeat(MAX_CLIENT_ADDRESS_LENGTH - 6));
        expect(detected?.clientAddress).not.toContain('\x01');
    });

    it('maskuje token w query tak jak w ścieżce', (): void => {
        SecretPaths.register(/\/(s|d)\/[A-Za-z0-9_-]{20,}/g, '/$1/***');

        const detected: HttpThreatDetectedEvent | null = detector.inspect(completedEvent(
            '/user/login?redirect=/d/abcdefghijklmnopqrstuvwxyz123456&x=1+union+select+1',
        ));

        expect(detected).not.toBeNull();
        expect(detected?.query).toContain('/d/***');
        expect(detected?.query).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
        expect(HttpThreatDetector.describe(detected as HttpThreatDetectedEvent)).not.toContain(
            'abcdefghijklmnopqrstuvwxyz123456',
        );
    });

    it('przekazuje referer tylko gdy trafienie go dotyczy', (): void => {
        const detected: HttpThreatDetectedEvent | null = detector.inspect(completedEvent('/home', {
            headers: {
                'host': 'example.com',
                'user-agent': 'Mozilla/5.0',
                'referer': 'https://evil.example/${jndi:ldap://x}',
            },
        }));

        expect(detected).not.toBeNull();
        expect(detected?.referer).toBe('https://evil.example/${jndi:ldap://x}');

        const withoutRefererThreat: HttpThreatDetectedEvent | null = detector.inspect(
            completedEvent(ATTACK_PATH_AND_QUERY),
        );
        expect(withoutRefererThreat).not.toBeNull();
        expect(withoutRefererThreat?.referer).toBeUndefined();
    });

    it('oznacza przerwane połączenie jako aborted', (): void => {
        const detected: HttpThreatDetectedEvent | null = detector.inspect(completedEvent(ATTACK_PATH_AND_QUERY, {
            processingTime: null,
        }));

        expect(detected?.aborted).toBe(true);
    });

    it('oczyszcza znaki sterujące w payloadzie', (): void => {
        const detected: HttpThreatDetectedEvent | null = detector.inspect(
            completedEvent('/search?q=%0a<script>'),
        );

        expect(detected).not.toBeNull();
        expect(detected?.query).toContain('\\x0a');
        expect(detected?.query).not.toContain('\n');
    });

    it('targetOrigin tylko dla obcego originu', (): void => {
        const foreign: HttpThreatDetectedEvent | null = detector.inspect(completedEvent('//evil.example/x'));
        expect(foreign?.targetOrigin).toBe('https://evil.example');

        const local: HttpThreatDetectedEvent | null = detector.inspect(completedEvent(ATTACK_PATH_AND_QUERY));
        expect(local).not.toBeNull();
        expect(local?.targetOrigin).toBeUndefined();
    });

    it('wyjątek w analizie nie wychodzi z listenera i jest logowany raz', (): void => {
        jest.spyOn(HttpThreatRules, 'match').mockImplementation((): never => {
            throw new Error('x');
        });
        detector.start();

        expect((): void => {
            eventBus.emit('http.request.completed', completedEvent(ATTACK_PATH_AND_QUERY));
            eventBus.emit('http.request.completed', completedEvent(ATTACK_PATH_AND_QUERY));
        }).not.toThrow();
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('okno throttle błędów trwa 10 minut i pokazuje liczbę pominiętych', (): void => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const throttledDetector: HttpThreatDetector = buildDetector(logger, eventBus);
        jest.spyOn(HttpThreatRules, 'match').mockImplementation((): never => {
            throw new Error('x');
        });
        throttledDetector.start();

        eventBus.emit('http.request.completed', completedEvent(ATTACK_PATH_AND_QUERY));
        eventBus.emit('http.request.completed', completedEvent(ATTACK_PATH_AND_QUERY));
        eventBus.emit('http.request.completed', completedEvent(ATTACK_PATH_AND_QUERY));

        expect(logger.error).toHaveBeenCalledTimes(1);

        nowSpy.mockReturnValue(1_000_000 + 599_999);
        eventBus.emit('http.request.completed', completedEvent(ATTACK_PATH_AND_QUERY));
        expect(logger.error).toHaveBeenCalledTimes(1);

        nowSpy.mockReturnValue(1_000_000 + 600_000);
        eventBus.emit('http.request.completed', completedEvent(ATTACK_PATH_AND_QUERY));

        expect(logger.error).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenLastCalledWith(
            '[HttpThreatDetector] inspection failed (3 similar errors suppressed)',
            expect.any(Error),
        );

        throttledDetector.stop();
    });

    it('stop odpina listener, a drugi start nie dubluje subskrypcji', (): void => {
        detector.start();
        detector.stop();

        eventBus.emit('http.request.completed', completedEvent(ATTACK_PATH_AND_QUERY));
        expect(detectedEvents).toHaveLength(0);

        detector.start();
        detector.start();

        eventBus.emit('http.request.completed', completedEvent(ATTACK_PATH_AND_QUERY));
        expect(detectedEvents).toHaveLength(1);
    });

    it('describe buduje jedną linię logu', (): void => {
        const detected: HttpThreatDetectedEvent = {
            requestId: 'Ab12Cd34Ef56',
            method: 'GET',
            path: '/articles/tag/bw',
            query: "page=1' UNION SELECT NULL--",
            statusCode: 200,
            aborted: false,
            threats: [
                {category: HttpThreatCategory.SqlInjection, rule: 'sql-union-select', input: 'query'},
                {category: HttpThreatCategory.Xss, rule: 'xss-script-tag', input: 'query'},
            ],
        };

        expect(HttpThreatDetector.describe(detected)).toBe(
            "HTTP threat sql-injection,xss from -: GET /articles/tag/bw?page=1' UNION SELECT NULL-- " +
            '-> 200 [sql-union-select/query, xss-script-tag/query] (request Ab12Cd34Ef56)',
        );
    });

    it('describe pokazuje wartości trafionych nagłówków i origin', (): void => {
        const detected: HttpThreatDetectedEvent = {
            requestId: 'Ab12Cd34Ef56',
            method: 'GET',
            host: 'evil.example',
            targetOrigin: 'https://evil.example',
            userAgent: 'Nikto/2.1.6',
            referer: 'https://evil.example/',
            path: '/wp-login.php',
            query: '',
            statusCode: 200,
            aborted: false,
            threats: [
                {category: HttpThreatCategory.MalformedRequest, rule: 'malformed-host', input: 'host'},
                {category: HttpThreatCategory.MalformedRequest, rule: 'malformed-origin', input: 'origin'},
                {category: HttpThreatCategory.ScannerUserAgent, rule: 'scanner-web-scanner', input: 'user-agent'},
                {category: HttpThreatCategory.CommandInjection, rule: 'command-jndi', input: 'referer'},
            ],
        };

        expect(HttpThreatDetector.describe(detected)).toBe(
            'HTTP threat malformed-request,scanner-user-agent,command-injection from -: ' +
            'GET /wp-login.php -> 200 ' +
            '[malformed-host/host, malformed-origin/origin, scanner-web-scanner/user-agent, command-jndi/referer] ' +
            'host=evil.example origin=https://evil.example ua="Nikto/2.1.6" referer="https://evil.example/" ' +
            '(request Ab12Cd34Ef56)',
        );
    });

    it('describe pokazuje tylko trafione wejścia', (): void => {
        const detected: HttpThreatDetectedEvent = {
            requestId: 'Ab12Cd34Ef56',
            method: 'GET',
            host: 'example.com',
            userAgent: 'Mozilla/5.0',
            path: '/wp-login.php',
            query: '',
            statusCode: 200,
            aborted: false,
            threats: [
                {category: HttpThreatCategory.ForeignTechnologyProbe, rule: 'foreign-wordpress', input: 'path'},
            ],
        };

        expect(HttpThreatDetector.describe(detected)).toBe(
            'HTTP threat foreign-technology-probe from -: GET /wp-login.php -> 200 ' +
            '[foreign-wordpress/path] (request Ab12Cd34Ef56)',
        );
    });

    it('describe pokazuje aborted zamiast statusu', (): void => {
        const detected: HttpThreatDetectedEvent = {
            requestId: 'Ab12Cd34Ef56',
            method: 'GET',
            path: '/wp-login.php',
            query: '',
            statusCode: 200,
            aborted: true,
            threats: [
                {category: HttpThreatCategory.ForeignTechnologyProbe, rule: 'foreign-wordpress', input: 'path'},
            ],
        };

        expect(HttpThreatDetector.describe(detected)).toContain('GET /wp-login.php -> aborted [foreign-wordpress/path]');
    });

    describe('adresy wewnętrzne', () => {
        const HEALTH_CHECK_HEADERS: Record<string, string> = {'host': '_', 'user-agent': 'Mozilla/5.0'};

        it('health check z sieci wewnętrznej z Host: _ nie daje zdarzenia', (): void => {
            const detected: HttpThreatDetectedEvent | null = detector.inspect(completedEvent('/api/status/health', {
                clientAddress: '172.28.0.2',
                headers: HEALTH_CHECK_HEADERS,
            }));

            expect(detected).toBeNull();
        });

        it('ten sam Host: _ z publicznego adresu daje malformed-host', (): void => {
            const detected: HttpThreatDetectedEvent | null = detector.inspect(completedEvent('/api/status/health', {
                clientAddress: '198.51.100.122',
                headers: HEALTH_CHECK_HEADERS,
            }));

            expect(detected?.threats).toContainEqual({
                category: HttpThreatCategory.MalformedRequest,
                rule: 'malformed-host',
                input: 'host',
            });
        });

        it('adres wewnętrzny ze ścieżką /.env nadal daje secret-file-probe', (): void => {
            const detected: HttpThreatDetectedEvent | null = detector.inspect(completedEvent('/.env', {
                clientAddress: '172.28.0.2',
            }));

            expect(detected?.threats).toContainEqual({
                category: HttpThreatCategory.SecretFileProbe,
                rule: 'secret-dotenv',
                input: 'path',
            });
        });
    });

    describe('podszywanie się pod przeglądarkę', () => {
        it('automat po przeglądarce z tego samego adresu daje trafienie z claimedUserAgent', (): void => {
            let now: number = 1_000_000;
            const spoofingDetector: HttpThreatDetector = buildDetector(logger, eventBus, (): number => now);
            spoofingDetector.start();

            eventBus.emit('http.request.completed', completedEvent('/home', {
                clientAddress: '203.0.113.9',
                headers: headersWithUserAgent(IPHONE_SAFARI_USER_AGENT),
            }));

            now += 1_000;

            eventBus.emit('http.request.completed', completedEvent('/user/get-token', {
                clientAddress: '203.0.113.9',
                headers: headersWithUserAgent(HEADLESS_CHROME_USER_AGENT),
            }));

            expect(detectedEvents).toHaveLength(1);
            const detected: HttpThreatDetectedEvent = detectedEvents[0];
            expect(detected.threats).toContainEqual({
                category: HttpThreatCategory.UserAgentSpoofing,
                rule: 'spoofing-automation-after-browser',
                input: 'user-agent',
            });
            expect(detected.claimedUserAgent).toBe(IPHONE_SAFARI_USER_AGENT);
            expect(HttpThreatDetector.describe(detected)).toContain('claimed="Mozilla/5.0 (iPhone;');
            expect(Object.keys(detected).sort()).toEqual([
                'aborted',
                'claimedUserAgent',
                'clientAddress',
                'host',
                'method',
                'path',
                'query',
                'requestId',
                'statusCode',
                'threats',
                'userAgent',
            ]);

            spoofingDetector.stop();
        });

        it('sam HeadlessChrome bez wcześniejszej przeglądarki zostaje czysty', (): void => {
            const detected: HttpThreatDetectedEvent | null = detector.inspect(completedEvent('/home', {
                clientAddress: '203.0.113.187',
                headers: headersWithUserAgent(HEADLESS_CHROME_USER_AGENT, {
                    'sec-ch-ua': '"Chromium";v="146", "HeadlessChrome";v="146"',
                }),
            }));

            expect(detected).toBeNull();
        });

        it('Client Hints z HeadlessChrome trafiają do payloadu i linii logu', (): void => {
            const clientHints: string = '"Chromium";v="138", "HeadlessChrome";v="138"';
            const detected: HttpThreatDetectedEvent | null = detector.inspect(completedEvent('/home', {
                headers: headersWithUserAgent(CHROME_USER_AGENT, {'sec-ch-ua': clientHints}),
            }));

            expect(detected).not.toBeNull();
            expect(detected?.threats).toContainEqual({
                category: HttpThreatCategory.UserAgentSpoofing,
                rule: 'spoofing-client-hints-headless',
                input: 'client-hints',
            });
            expect(detected?.clientHints).toBe(clientHints);
            expect(HttpThreatDetector.describe(detected as HttpThreatDetectedEvent)).toContain(`ch="${clientHints}"`);
            expect(Object.keys(detected as HttpThreatDetectedEvent).sort()).toEqual([
                'aborted',
                'clientAddress',
                'clientHints',
                'host',
                'method',
                'path',
                'query',
                'requestId',
                'statusCode',
                'threats',
                'userAgent',
            ]);
        });

        it('bierze pierwszy nagłówek sec-ch-ua i ucina go do 512 znaków', (): void => {
            const firstHeader: string = '"Chromium";v="138", "HeadlessChrome";v="138"';
            const detected: HttpThreatDetectedEvent | null = detector.inspect(completedEvent('/home', {
                headers: headersWithUserAgent(CHROME_USER_AGENT, {
                    'sec-ch-ua': [firstHeader, '"Chromium";v="138"'],
                }),
            }));

            expect(detected?.clientHints).toBe(firstHeader);

            const longHeader: string = firstHeader + 'a'.repeat(2000);
            const truncated: HttpThreatDetectedEvent | null = detector.inspect(completedEvent('/home', {
                headers: headersWithUserAgent(CHROME_USER_AGENT, {'sec-ch-ua': longHeader}),
            }));

            expect(truncated?.clientHints).toHaveLength(MAX_HEADER_TEXT_LENGTH);
        });

        it('bez clientAddress tracker nie jest wołany', (): void => {
            const observeSpy = jest.spyOn(UserAgentConsistencyTracker.prototype, 'observe');

            expect(detector.inspect(completedEvent('/home', {
                headers: headersWithUserAgent(IPHONE_SAFARI_USER_AGENT),
            }))).toBeNull();

            expect(detector.inspect(completedEvent('/user/get-token', {
                headers: headersWithUserAgent(HEADLESS_CHROME_USER_AGENT),
            }))).toBeNull();

            expect(observeSpy).not.toHaveBeenCalled();
            observeSpy.mockRestore();
        });

        it('wyłączona kategoria UserAgentSpoofing nie woła trackera', (): void => {
            const observeSpy = jest.spyOn(UserAgentConsistencyTracker.prototype, 'observe');
            const disabledDetector: HttpThreatDetector = new HttpThreatDetector({
                allowedOrigin: ALLOWED_ORIGIN,
                allowedHosts: ['example.com', 'www.example.com'],
                disabledCategories: [HttpThreatCategory.UserAgentSpoofing],
            }, logger, eventBus);

            expect(disabledDetector.inspect(completedEvent('/home', {
                clientAddress: '203.0.113.9',
                headers: headersWithUserAgent(IPHONE_SAFARI_USER_AGENT),
            }))).toBeNull();

            expect(observeSpy).not.toHaveBeenCalled();
            observeSpy.mockRestore();
        });
    });
});
