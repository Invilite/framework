export const CRON_DEFAULT_TIMEZONE: string = 'Europe/Warsaw';

type WallClockParts = {
    year: number;
    month: number;
    dayOfMonth: number;
    hour: number;
    minute: number;
    dayOfWeek: number;
};

type CronFields = {
    minutes: Set<number>;
    hours: Set<number>;
    daysOfMonth: Set<number>;
    months: Set<number>;
    daysOfWeek: Set<number>;
    domRestricted: boolean;
    dowRestricted: boolean;
};

const FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'] as const;

const FIELD_RANGES: Record<(typeof FIELD_NAMES)[number], [number, number]> = {
    'minute': [0, 59],
    'hour': [0, 23],
    'day-of-month': [1, 31],
    'month': [1, 12],
    'day-of-week': [0, 7],
};

const WEEKDAY_MAP: Record<string, number> = {Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6};

function parseField(expression: string, fieldIndex: number): Set<number> {
    const fieldName: "minute" | "hour" | "day-of-month" | "month" | "day-of-week" = FIELD_NAMES[fieldIndex];
    const [min, max] = FIELD_RANGES[fieldName];
    const values: Set<number> = new Set<number>();

    for (const part of expression.split(',')) {
        const stepMatch: RegExpMatchArray | null = part.match(/^(?:\*|(\d+)-(\d+))\/(\d+)$/);
        const rangeMatch: RegExpMatchArray | null = part.match(/^(\d+)-(\d+)$/);
        const singleMatch: RegExpMatchArray | null = part.match(/^\d+$/);

        if (stepMatch) {
            const step: number = Number(stepMatch[3]);
            if (step < 1) {
                throw new Error(`Invalid step "${step}" in ${fieldName} field`);
            }
            const start: number = stepMatch[1] !== undefined ? Number(stepMatch[1]) : min;
            const end: number = stepMatch[1] !== undefined ? Number(stepMatch[2]) : max;
            if (start < min || end > max || start > end) {
                throw new Error(`Range ${start}-${end} out of bounds for ${fieldName} field`);
            }
            for (let v: number = start; v <= end; v += step) {
                values.add(v);
            }
        } else if (rangeMatch) {
            const start: number = Number(rangeMatch[1]);
            const end: number = Number(rangeMatch[2]);
            if (start < min || end > max || start > end) {
                throw new Error(`Range ${start}-${end} out of bounds for ${fieldName} field`);
            }
            for (let v: number = start; v <= end; v++) {
                values.add(v);
            }
        } else if (singleMatch) {
            const value: number = Number(part);
            if (value < min || value > max) {
                throw new Error(`Value ${value} out of bounds for ${fieldName} field`);
            }
            values.add(value);
        } else if (part === '*') {
            for (let v: number = min; v <= max; v++) {
                values.add(v);
            }
        } else {
            throw new Error(`Invalid ${fieldName} field value "${part}"`);
        }
    }

    return values;
}

export class CronExpression {
    private readonly fields: CronFields;
    private readonly timeZone: string;
    private readonly formatter: Intl.DateTimeFormat;

    private constructor(fields: CronFields, timeZone: string) {
        this.fields = fields;
        this.timeZone = timeZone;

        try {
            this.formatter = new Intl.DateTimeFormat('en-GB', {
                timeZone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                weekday: 'short',
                hourCycle: 'h23',
            });
        } catch {
            throw new Error(`Unknown time zone "${timeZone}"`);
        }
    }

    public static parse(expression: string, timeZone: string = CRON_DEFAULT_TIMEZONE): CronExpression {
        const parts: string[] = expression.trim().split(/\s+/);
        if (parts.length !== 5) {
            throw new Error(`Cron expression must have exactly 5 fields, got ${parts.length}: "${expression}"`);
        }

        const minutes: Set<number> = parseField(parts[0], 0);
        const hours: Set<number> = parseField(parts[1], 1);
        const daysOfMonth: Set<number> = parseField(parts[2], 2);
        const months: Set<number> = parseField(parts[3], 3);
        const daysOfWeek: Set<number> = parseField(parts[4], 4);

        // vixie-cron convention: 0 and 7 both mean Sunday.
        if (daysOfWeek.has(7)) {
            daysOfWeek.delete(7);
            daysOfWeek.add(0);
        }

        const fields: CronFields = {
            minutes,
            hours,
            daysOfMonth,
            months,
            daysOfWeek,
            domRestricted: parts[2] !== '*',
            dowRestricted: parts[4] !== '*',
        };

        return new CronExpression(fields, timeZone);
    }

    public getTimeZone(): string {
        return this.timeZone;
    }

    /**
     * Whether the wall-clock time of `date` in the configured timezone matches
     * the cron fields. Day-of-month and day-of-week combine with OR when both
     * are restricted (vixie-cron standard).
     */
    public matches(date: Date): boolean {
        const parts: WallClockParts | null = this.getWallClockParts(date);
        if (parts === null) {
            return false;
        }

        if (!this.fields.months.has(parts.month)) {
            return false;
        }
        if (!this.fields.hours.has(parts.hour) || !this.fields.minutes.has(parts.minute)) {
            return false;
        }

        return this.canDayMatch(parts);
    }

    /**
     * First matching instant strictly after `from`, or null when no match
     * exists within a 4-year horizon. DST gap wall times never match (skipped);
     * DST overlap wall times match at both UTC instants (caller deduplicates).
     */
    public next(from: Date): Date | null {
        const fromMs: number = from.getTime();
        const horizonMs: number = fromMs + 4 * 365.25 * 24 * 60 * 60 * 1000;

        const fromParts: WallClockParts | null = this.getWallClockParts(from);
        if (fromParts === null) {
            return null;
        }

        // Iterate wall-clock minutes (wall arithmetic, not a UTC cursor): a
        // UTC cursor would jump over the first instant of a DST fall-back
        // overlap, silently skipping occurrences within that hour.
        let wallMs: number = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.dayOfMonth, fromParts.hour, fromParts.minute);

        // Guard bound: wall minutes per 4-year horizon ~2.1M; pruning makes
        // the real iteration count tiny, the guard only caps pathologies.
        for (let guard: number = 0; guard < 2_500_000; guard++) {
            // No materialized instant can be <= horizon once the wall time
            // exceeds it by more than the maximum timezone offset (+14h).
            if (wallMs > horizonMs + 15 * 24 * 60 * 60 * 1000) {
                return null;
            }

            const wallDate: Date = new Date(wallMs);
            const parts: WallClockParts = {
                year: wallDate.getUTCFullYear(),
                month: wallDate.getUTCMonth() + 1,
                dayOfMonth: wallDate.getUTCDate(),
                hour: wallDate.getUTCHours(),
                minute: wallDate.getUTCMinutes(),
                dayOfWeek: wallDate.getUTCDay(),
            };

            if (!this.fields.months.has(parts.month)) {
                wallMs = Date.UTC(parts.year, parts.month, 1);
                continue;
            }

            if (!this.canDayMatch(parts)) {
                wallMs = Date.UTC(parts.year, parts.month - 1, parts.dayOfMonth + 1);
                continue;
            }

            if (!this.fields.hours.has(parts.hour)) {
                wallMs = Date.UTC(parts.year, parts.month - 1, parts.dayOfMonth, parts.hour + 1, 0);
                continue;
            }

            if (!this.fields.minutes.has(parts.minute)) {
                wallMs += 60000;
                continue;
            }

            // All fields match: materialize the UTC instant(s) - a fall-back
            // overlap wall time maps to two - and take the earliest instant
            // strictly after `from`.
            for (const candidateMs of this.wallTimeToUtcCandidates(parts)) {
                if (candidateMs > fromMs && candidateMs <= horizonMs) {
                    return new Date(candidateMs);
                }
            }

            wallMs += 60000;
        }

        return null;
    }

    /**
     * Stable wall-clock identity of an instant ("YYYY-MM-DD HH:mm" in the
     * schedule's timezone). Used by callers to deduplicate DST fall-back
     * overlaps (the same wall time occurs at two UTC instants).
     */
    public wallClockKey(date: Date): string {
        const parts: WallClockParts | null = this.getWallClockParts(date);
        if (parts === null) {
            throw new Error('Instant does not map to a wall-clock time');
        }

        const pad: (value: number) => string = (value: number): string => String(value).padStart(2, '0');
        return `${parts.year}-${pad(parts.month)}-${pad(parts.dayOfMonth)} ${pad(parts.hour)}:${pad(parts.minute)}`;
    }

    private canDayMatch(parts: WallClockParts): boolean {
        const domMatch: boolean = this.fields.domRestricted && this.fields.daysOfMonth.has(parts.dayOfMonth);
        const dowMatch: boolean = this.fields.dowRestricted && this.fields.daysOfWeek.has(parts.dayOfWeek);

        if (this.fields.domRestricted && this.fields.dowRestricted) {
            return domMatch || dowMatch;
        }
        if (this.fields.domRestricted) {
            return domMatch;
        }
        if (this.fields.dowRestricted) {
            return dowMatch;
        }

        return true;
    }

    /**
     * Wall-clock parts of `date` in the configured timezone. Never null for
     * real instants - DST gaps do not produce nonexistent wall times, the
     * formatter maps gap-adjacent instants to the shifted wall time instead.
     */
    private getWallClockParts(date: Date): WallClockParts | null {
        const parts: Record<string, string> = {};
        for (const part of this.formatter.formatToParts(date)) {
            if (part.type !== 'literal') {
                parts[part.type] = part.value;
            }
        }

        const hour: number = Number(parts.hour);
        if (Number.isNaN(hour) || parts.weekday === undefined) {
            return null;
        }

        return {
            year: Number(parts.year),
            month: Number(parts.month),
            dayOfMonth: Number(parts.day),
            hour: hour,
            minute: Number(parts.minute),
            dayOfWeek: WEEKDAY_MAP[parts.weekday] ?? -1,
        };
    }

    /**
     * UTC instants whose wall clock equals the given wall time, ascending.
     * Most wall times map to one instant; a DST fall-back overlap maps to two
     * and a DST spring gap to none (verified by round-trip). Offsets are
     * sampled around the naive instant because the offset at the naive guess
     * alone always resolves an ambiguous time to the same (later) instant.
     */
    private wallTimeToUtcCandidates(parts: WallClockParts): number[] {
        const naive: number = Date.UTC(parts.year, parts.month - 1, parts.dayOfMonth, parts.hour, parts.minute);

        const offsets: Set<number> = new Set<number>();
        for (const sampleMs of [naive - 24 * 60 * 60 * 1000, naive, naive + 24 * 60 * 60 * 1000]) {
            offsets.add(this.timezoneOffsetMinutes(new Date(sampleMs)));
        }

        const candidates: number[] = [];
        for (const offset of offsets) {
            const candidateMs: number = naive - offset * 60000;
            const candidateParts: WallClockParts | null = this.getWallClockParts(new Date(candidateMs));
            if (candidateParts !== null
                && Date.UTC(candidateParts.year, candidateParts.month - 1, candidateParts.dayOfMonth, candidateParts.hour, candidateParts.minute) === naive) {
                candidates.push(candidateMs);
            }
        }

        candidates.sort((first, second) => first - second);
        return candidates;
    }

    private timezoneOffsetMinutes(date: Date): number {
        const parts: WallClockParts | null = this.getWallClockParts(date);
        if (parts === null) {
            return 0;
        }

        const wallMs: number = Date.UTC(parts.year, parts.month - 1, parts.dayOfMonth, parts.hour, parts.minute);
        return Math.round((wallMs - date.getTime()) / 60000);
    }
}