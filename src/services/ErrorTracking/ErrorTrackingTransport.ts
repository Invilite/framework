import util from "util";
import {LogLevel} from "@invilite/logger";
import {AbstractTransport} from "@invilite/logger/Transports";
import {TransportArguments} from "@invilite/logger/Transports/AbstractTransport";
import {ErrorTrackingClient, ErrorTrackingContext, ErrorTrackingLevel} from "./ErrorTracking";
import {RepeatThrottle} from "../../utils/RepeatThrottle";

export interface ErrorTrackingTransportOptions {
    /** The same problem (same fingerprint) is sent at most once per this window; repeats are counted. */
    repeatWindowMs: number;
    now?: () => number;
}

const MAX_MESSAGE_LENGTH: number = 4000;

/**
 * Logger transport that forwards `error` and more severe log lines to error tracking. The application already logs
 * every failure - this sends them on without touching the call sites. Repeats are throttled to protect the event quota.
 */
export default class ErrorTrackingTransport extends AbstractTransport {
    private readonly repeats: RepeatThrottle;

    public constructor(private readonly client: ErrorTrackingClient, options: ErrorTrackingTransportOptions) {
        super(LogLevel.error);
        this.repeats = new RepeatThrottle(options.repeatWindowMs, 1000, options.now);
    }

    /** Replaces numbers so that "took 1204 ms" and "took 1377 ms" count as the same problem. */
    public static normalize(text: string): string {
        return text.replace(/\d+(\.\d+)?/g, '<n>').slice(0, 500);
    }

    public write(level: LogLevel, args: TransportArguments): boolean {
        if (level > this.logLevel || level === LogLevel.silent) {
            return false;
        }

        try {
            return this.report(level, args);
        } catch {
            // Reporting is best effort - a broken tracker must never break logging.
            return false;
        }
    }

    private report(level: LogLevel, args: TransportArguments): boolean {
        const error: Error | undefined = args.content.find((part: unknown): part is Error => part instanceof Error);
        const message: string = args.content
            .filter((part: unknown): boolean => part !== error)
            .map((part: unknown): string => typeof part === 'string' ? part : util.inspect(part, {depth: 3, breakLength: Infinity}))
            .join(' ')
            .slice(0, MAX_MESSAGE_LENGTH);

        const fingerprintKey: string = error
            ? `${error.name}|${ErrorTrackingTransport.normalize(error.message)}|${ErrorTrackingTransport.firstStackFrame(error)}`
            : ErrorTrackingTransport.normalize(message);
        const suppressedCount: number | null = this.repeats.claim(fingerprintKey);
        if (suppressedCount === null) {
            return false;
        }

        const tags: Record<string, string> = {logLevel: args.levelName};
        if (args.requestId) {
            tags.requestId = args.requestId;
        }
        const extra: Record<string, unknown> = {suppressedRepeats: suppressedCount};
        const trackingLevel: ErrorTrackingLevel = level <= LogLevel.critical ? 'fatal' : 'error';

        if (error) {
            if (message !== '') {
                extra.logMessage = message;
            }
            const context: ErrorTrackingContext = {level: trackingLevel, fingerprint: null, tags, extra};
            this.client.captureException(error, context);
        } else {
            const context: ErrorTrackingContext = {level: trackingLevel, fingerprint: ['log', fingerprintKey], tags, extra};
            this.client.captureMessage(message, context);
        }

        return true;
    }

    private static firstStackFrame(error: Error): string {
        const frame: string | undefined = (error.stack ?? '').split('\n').find((line: string): boolean => line.trimStart().startsWith('at '));

        return frame ? frame.trim() : '';
    }
}
