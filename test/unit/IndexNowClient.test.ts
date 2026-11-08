import axios from 'axios';
import {AbstractLogger} from '../../src/types/interfaces/AbstractLogger';
import {IndexNowClient} from '../../src/services/IndexNow/IndexNowClient';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const KEY: string = '7a1dfff8d6e740f2b150afda4ec513d7';
const HOST: string = 'example.com';
const KEY_LOCATION: string = `https://${HOST}/${KEY}.txt`;
const ENDPOINT: string = 'https://api.indexnow.org/indexnow';
const HOUR: number = 3_600_000;

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

function buildClient(logger: AbstractLogger, overrides: Partial<{
    batchDelayMs: number;
    throttleMs: number;
}> = {}): IndexNowClient {
    return new IndexNowClient({
        host: HOST,
        key: KEY,
        keyLocation: KEY_LOCATION,
        ...overrides,
    }, logger);
}

describe('IndexNowClient', () => {
    let logger: ReturnType<typeof buildLogger>;

    beforeEach((): void => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-10-28T00:00:00.000Z'));
        jest.resetAllMocks();
        logger = buildLogger();
        mockedAxios.post.mockResolvedValue({status: 200});
    });

    afterEach((): void => {
        jest.useRealTimers();
    });

    it('deduplicatesAndSendsOneBatchAfterDelay', async (): Promise<void> => {
        const client: IndexNowClient = buildClient(logger);

        client.submit(['https://example.com/u/a', 'https://example.com/u/a']);
        client.submit(['https://example.com/u/b']);

        await jest.advanceTimersByTimeAsync(HOUR - 1);
        expect(mockedAxios.post).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(mockedAxios.post).toHaveBeenCalledTimes(1);
        expect(mockedAxios.post).toHaveBeenCalledWith(
            ENDPOINT,
            {
                host: HOST,
                key: KEY,
                keyLocation: KEY_LOCATION,
                urlList: ['https://example.com/u/a', 'https://example.com/u/b'],
            },
            expect.objectContaining({
                headers: {'Content-Type': 'application/json; charset=utf-8'},
                timeout: 10_000,
            }),
        );
    });

    it('splitsIntoBatchesOf10000', async (): Promise<void> => {
        const client: IndexNowClient = buildClient(logger);
        const urls: string[] = Array.from(
            {length: 10_001},
            (_value: unknown, index: number): string => `https://example.com/u/${index}`,
        );

        client.submit(urls);
        await client.flush();

        expect(mockedAxios.post).toHaveBeenCalledTimes(2);
        const firstBody: {urlList: string[]} = mockedAxios.post.mock.calls[0][1] as {urlList: string[]};
        const secondBody: {urlList: string[]} = mockedAxios.post.mock.calls[1][1] as {urlList: string[]};
        expect(firstBody.urlList).toHaveLength(10_000);
        expect(secondBody.urlList).toHaveLength(1);
    });

    it('rejectsUrlsFromOtherHosts', async (): Promise<void> => {
        const client: IndexNowClient = buildClient(logger);

        client.submit([
            'http://example.com/x',
            'https://www.example.com/x',
            'https://example.org/x',
            'https://example.com/u/valid',
        ]);
        await client.flush();

        const body: {urlList: string[]} = mockedAxios.post.mock.calls[0][1] as {urlList: string[]};
        expect(body.urlList).toEqual(['https://example.com/u/valid']);
        expect(logger.warning).toHaveBeenCalledTimes(3);
        for (const call of logger.warning.mock.calls) {
            expect(String(call[0])).toContain('[IndexNow]');
        }
    });

    it('networkErrorIsLoggedNotThrown', async (): Promise<void> => {
        mockedAxios.post.mockRejectedValue(new Error('network down'));
        const client: IndexNowClient = buildClient(logger);

        client.submit(['https://example.com/u/a', 'https://example.com/u/b']);

        await expect(client.flush()).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalled();
        const logged: string = logger.error.mock.calls
            .map((call: unknown[]): string => String(call[0]))
            .join(' ');
        expect(logged).toContain('[IndexNow]');
        expect(logged).toContain('2');
    });

    it('pausesAfter429', async (): Promise<void> => {
        mockedAxios.post
            .mockResolvedValueOnce({status: 429})
            .mockResolvedValue({status: 200});
        const client: IndexNowClient = buildClient(logger, {throttleMs: 7_200_000});

        client.submit(['https://example.com/u/a']);
        await jest.advanceTimersByTimeAsync(HOUR);
        expect(mockedAxios.post).toHaveBeenCalledTimes(1);

        client.submit(['https://example.com/u/b']);
        await jest.advanceTimersByTimeAsync(HOUR);
        expect(mockedAxios.post).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(HOUR);
        expect(mockedAxios.post).toHaveBeenCalledTimes(2);
        const body: {urlList: string[]} = mockedAxios.post.mock.calls[1][1] as {urlList: string[]};
        expect(body.urlList).toEqual(['https://example.com/u/a', 'https://example.com/u/b']);
    });

    it('defaultThrottleAfter429IsOneHour', async (): Promise<void> => {
        mockedAxios.post
            .mockResolvedValueOnce({status: 429})
            .mockResolvedValue({status: 200});
        const client: IndexNowClient = buildClient(logger);

        client.submit(['https://example.com/u/a']);
        await jest.advanceTimersByTimeAsync(HOUR);
        expect(mockedAxios.post).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(HOUR - 1);
        expect(mockedAxios.post).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('stopFlushesPending', async (): Promise<void> => {
        const client: IndexNowClient = buildClient(logger);

        client.submit(['https://example.com/u/a']);
        await client.stop();

        expect(mockedAxios.post).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });
});
