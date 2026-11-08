/**
 * Minimal iCalendar (RFC 5545) writer - VCALENDAR with VEVENTs, no dependencies.
 *
 * All times are written in UTC (`YYYYMMDDTHHMMSSZ`), so no VTIMEZONE block is needed - the calendar app
 * converts to the viewer's local time. Lines end with CRLF and are folded at 75 OCTETS of UTF-8 (not
 * characters - Polish letters take 2 bytes, emoji 4), never splitting a multi-byte character.
 */
export type IcsEventStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';

export type IcsEvent = {
    /** Globally unique and stable - the same UID updates the event in the client instead of duplicating it. */
    uid: string;
    start: Date;
    end: Date;
    /** DTSTAMP - when this representation was created (for feeds: last modification of the source). */
    stamp: Date;
    lastModified?: Date;
    summary: string;
    description?: string | null;
    location?: string | null;
    url?: string | null;
    status?: IcsEventStatus;
};

export type IcsCalendar = {
    /** PRODID, e.g. `-//Example//Calendar//PL`. */
    prodId: string;
    /** Display name for subscribing clients (X-WR-CALNAME). */
    name?: string;
    /** METHOD (e.g. PUBLISH for an e-mail attachment); omitted for subscription feeds. */
    method?: string;
    /** Suggested refresh interval for subscribing clients (REFRESH-INTERVAL + X-PUBLISHED-TTL). */
    refreshMinutes?: number;
    events: IcsEvent[];
};

const MAX_LINE_OCTETS: number = 75;
const CONTROL_CHARACTERS: RegExp = /[\u0000-\u001F\u007F]/;

export class ICalendar {
    public static build(calendar: IcsCalendar): string {
        ICalendar.assertSafeValue(calendar.prodId, 'PRODID');
        if (calendar.method) {
            ICalendar.assertSafeValue(calendar.method, 'METHOD');
        }
        const lines: string[] = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            `PRODID:${calendar.prodId}`,
            'CALSCALE:GREGORIAN',
        ];
        if (calendar.method) {
            lines.push(`METHOD:${calendar.method}`);
        }
        if (calendar.name) {
            lines.push(`X-WR-CALNAME:${ICalendar.escapeText(calendar.name)}`);
        }
        if (calendar.refreshMinutes && calendar.refreshMinutes > 0) {
            const duration: string = ICalendar.formatDuration(calendar.refreshMinutes);
            lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${duration}`);
            lines.push(`X-PUBLISHED-TTL:${duration}`);
        }
        for (const event of calendar.events) {
            lines.push(...ICalendar.eventLines(event));
        }
        lines.push('END:VCALENDAR');
        return lines.map((line: string) => ICalendar.foldLine(line)).join('\r\n') + '\r\n';
    }

    /** UTC date-time in iCalendar basic format: 20261008T153000Z. */
    public static formatDate(date: Date): string {
        return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
    }

    /** TEXT value escaping (RFC 5545 §3.3.11): backslash, semicolon, comma, newline. */
    public static escapeText(value: string): string {
        return value
            .replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\r\n|\r|\n/g, '\\n');
    }

    /**
     * Folds a content line to at most 75 octets per physical line; continuation lines start with a single
     * space (which counts towards their 75 octets). Splits only between code points.
     */
    public static foldLine(line: string): string {
        if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_OCTETS) {
            return line;
        }
        const parts: string[] = [];
        let current: string = '';
        let currentOctets: number = 0;
        let limit: number = MAX_LINE_OCTETS;
        for (const char of line) {
            const octets: number = Buffer.byteLength(char, 'utf8');
            if (currentOctets + octets > limit) {
                parts.push(current);
                current = '';
                currentOctets = 0;
                limit = MAX_LINE_OCTETS - 1;
            }
            current += char;
            currentOctets += octets;
        }
        parts.push(current);
        return parts.join('\r\n ');
    }

    private static eventLines(event: IcsEvent): string[] {
        ICalendar.assertSafeValue(event.uid, 'UID');
        if (event.url) {
            ICalendar.assertHttpUrl(event.url, 'URL');
        }
        if (event.status) {
            ICalendar.assertSafeValue(event.status, 'STATUS');
        }
        const lines: string[] = [
            'BEGIN:VEVENT',
            `UID:${event.uid}`,
            `DTSTAMP:${ICalendar.formatDate(event.stamp)}`,
            `DTSTART:${ICalendar.formatDate(event.start)}`,
            `DTEND:${ICalendar.formatDate(event.end)}`,
        ];
        if (event.lastModified) {
            lines.push(`LAST-MODIFIED:${ICalendar.formatDate(event.lastModified)}`);
        }
        lines.push(`SUMMARY:${ICalendar.escapeText(event.summary)}`);
        if (event.description) {
            lines.push(`DESCRIPTION:${ICalendar.escapeText(event.description)}`);
        }
        if (event.location) {
            lines.push(`LOCATION:${ICalendar.escapeText(event.location)}`);
        }
        if (event.url) {
            lines.push(`URL:${event.url}`);
        }
        if (event.status) {
            lines.push(`STATUS:${event.status}`);
        }
        lines.push('END:VEVENT');
        return lines;
    }

    private static assertSafeValue(value: string, property: string): void {
        if (CONTROL_CHARACTERS.test(value)) {
            throw new Error(`${property} must not contain control characters`);
        }
    }

    private static assertHttpUrl(value: string, property: string): void {
        ICalendar.assertSafeValue(value, property);

        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch {
            throw new Error(`${property} must be an absolute http(s) URL`);
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`${property} must be an absolute http(s) URL`);
        }
    }

    private static formatDuration(minutes: number): string {
        const hours: number = Math.floor(minutes / 60);
        const rest: number = minutes % 60;
        return 'PT' + (hours ? `${hours}H` : '') + (rest ? `${rest}M` : '');
    }
}
