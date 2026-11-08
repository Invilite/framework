import {LogLevel} from "@invilite/logger";
import {TransportArguments} from "@invilite/logger/Transports/AbstractTransport";
import ErrorTracking, {ErrorTrackingClient, ErrorTrackingContext} from "../../src/services/ErrorTracking/ErrorTracking";
import ErrorTrackingTransport from "../../src/services/ErrorTracking/ErrorTrackingTransport";

function makeArgs(content: any[], levelName: string = 'error', requestId?: string): TransportArguments {
    return {levelName, content, time: new Date(0), timeString: '', requestId, processName: undefined};
}

function makeTrackingClient() {
    return {
        captureException: jest.fn<void, [Error, ErrorTrackingContext]>(),
        captureMessage: jest.fn<void, [string, ErrorTrackingContext]>(),
    } satisfies ErrorTrackingClient;
}

describe('ErrorTrackingTransport', () => {
    it('ignores levels below error', () => {
        const client = makeTrackingClient();
        const transport: ErrorTrackingTransport = new ErrorTrackingTransport(client, {repeatWindowMs: 1000});

        expect(transport.write(LogLevel.warning, makeArgs(['slow'], 'warning'))).toBe(false);
        expect(transport.write(LogLevel.debug, makeArgs(['sql'], 'debug'))).toBe(false);

        expect(client.captureMessage).not.toHaveBeenCalled();
    });

    it('sends an Error as an exception with the other parts as the log message', () => {
        const client = makeTrackingClient();
        const transport: ErrorTrackingTransport = new ErrorTrackingTransport(client, {repeatWindowMs: 1000});
        const failure: Error = new Error('boom');

        transport.write(LogLevel.emergency, makeArgs(['WebServer error:', failure], 'emergency', 'req-1'));

        expect(client.captureException).toHaveBeenCalledWith(failure, {
            level: 'fatal',
            fingerprint: null,
            tags: {logLevel: 'emergency', requestId: 'req-1'},
            extra: {suppressedRepeats: 0, logMessage: 'WebServer error:'},
        });
    });

    it('sends text as a message grouped regardless of numbers', () => {
        const client = makeTrackingClient();
        const transport: ErrorTrackingTransport = new ErrorTrackingTransport(client, {repeatWindowMs: 1000, now: () => 0});

        transport.write(LogLevel.error, makeArgs(['Query very-slow: 1204 ms', {pool: 3}]));
        transport.write(LogLevel.error, makeArgs(['Query very-slow: 1377 ms', {pool: 4}]));

        expect(client.captureMessage).toHaveBeenCalledTimes(1);
        const [message, context] = client.captureMessage.mock.calls[0];
        expect(message).toBe('Query very-slow: 1204 ms { pool: 3 }');
        expect(context.level).toBe('error');
        expect(context.fingerprint).toEqual(['log', 'Query very-slow: <n> ms { pool: <n> }']);
    });

    it('reports how many repeats were swallowed when the window reopens', () => {
        const client = makeTrackingClient();
        let now: number = 0;
        const transport: ErrorTrackingTransport = new ErrorTrackingTransport(client, {repeatWindowMs: 1000, now: () => now});
        const failure = (): Error => new Error('same failure');

        transport.write(LogLevel.error, makeArgs([failure()]));
        now = 10;
        transport.write(LogLevel.error, makeArgs([failure()]));
        now = 1000;
        transport.write(LogLevel.error, makeArgs([failure()]));

        expect(client.captureException).toHaveBeenCalledTimes(2);
        expect(client.captureException.mock.calls[1][1].extra.suppressedRepeats).toBe(1);
    });

    it('never throws when the tracker fails', () => {
        const client = makeTrackingClient();
        client.captureMessage.mockImplementation(() => {
            throw new Error('network down');
        });
        const transport: ErrorTrackingTransport = new ErrorTrackingTransport(client, {repeatWindowMs: 1000});

        expect(transport.write(LogLevel.critical, makeArgs(['critical thing'], 'critical'))).toBe(false);
    });
});

describe('ErrorTracking scrubbing', () => {
    it('removes cookies, bodies, query strings, user and unlisted headers', () => {
        const event: any = ErrorTracking.scrubEvent({
            type: undefined,
            user: {id: '42', email: 'someone@example.com'},
            request: {
                url: 'https://example.com/user/reset?token=secret#x',
                cookies: {session: 'abc'},
                data: {password: 'x'},
                query_string: 'token=secret',
                headers: {'User-Agent': 'jest', Authorization: 'Bearer secret', cookie: 'session=abc'},
            },
        });

        expect(event.user).toBeUndefined();
        expect(event.request).toEqual({url: 'https://example.com/user/reset', headers: {'User-Agent': 'jest'}});
    });

    it('masks PostgreSQL row values in messages, exceptions and extras', () => {
        const event: any = ErrorTracking.scrubEvent({
            type: undefined,
            message: 'duplicate key value violates unique constraint "users_email_key", Key (email)=(someone@example.com) already exists.',
            exception: {values: [{type: 'SqlError', value: 'null value in column "x", Failing row contains (1, someone@example.com, null).'}]},
            extra: {logMessage: 'insert or update violates foreign key, Key (user_id)=(42) is not present in table "users".', suppressedRepeats: 0},
        });

        expect(event.message).toBe('duplicate key value violates unique constraint "users_email_key", Key (email)=(…) already exists.');
        expect(event.exception.values[0].value).toBe('null value in column "x", Failing row contains (…).');
        expect(event.extra.logMessage).toBe('insert or update violates foreign key, Key (user_id)=(…) is not present in table "users".');
        expect(JSON.stringify(event)).not.toContain('someone@example.com');
    });

    it('strips query strings from breadcrumb URLs', () => {
        expect(ErrorTracking.scrubBreadcrumb({data: {url: 'https://api.example.com/v1?key=secret'}})).toEqual({data: {url: 'https://api.example.com/v1'}});
        expect(ErrorTracking.stripQuery('/a/b')).toBe('/a/b');
    });
});
