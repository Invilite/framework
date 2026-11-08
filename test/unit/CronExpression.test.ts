import {CRON_DEFAULT_TIMEZONE, CronExpression} from "../../src/utils/CronExpression";

describe('CronExpression', () => {
    describe('parse', () => {
        test('accepts a valid 5-field expression', () => {
            expect(() => CronExpression.parse('*/15 * * * *')).not.toThrow();
        });

        test('rejects wrong field count', () => {
            expect(() => CronExpression.parse('* * * *')).toThrow(/exactly 5 fields/);
            expect(() => CronExpression.parse('* * * * * *')).toThrow(/exactly 5 fields/);
        });

        test('rejects out-of-bounds values', () => {
            expect(() => CronExpression.parse('60 * * * *')).toThrow(/minute/);
            expect(() => CronExpression.parse('* 24 * * *')).toThrow(/hour/);
            expect(() => CronExpression.parse('* * 32 * *')).toThrow(/day-of-month/);
            expect(() => CronExpression.parse('* * * 13 *')).toThrow(/month/);
            expect(() => CronExpression.parse('* * * * 8')).toThrow(/day-of-week/);
        });

        test('rejects garbage fields', () => {
            expect(() => CronExpression.parse('abc * * * *')).toThrow(/Invalid minute field/);
            expect(() => CronExpression.parse('*/0 * * * *')).toThrow(/step/);
            expect(() => CronExpression.parse('10-5 * * * *')).toThrow(/out of bounds|start/);
        });

        test('rejects unknown timezone', () => {
            expect(() => CronExpression.parse('* * * * *', 'Mars/Olympus')).toThrow(/Unknown time zone/);
        });
    });

    describe('matches', () => {
        // 2026-06-15 is a Monday; 10:30 Warsaw = 08:30 UTC (CEST, +2)
        const monday = new Date('2026-06-15T08:30:00Z');
        // 2026-06-21 is a Sunday
        const sunday = new Date('2026-06-21T08:30:00Z');

        test('matches exact minute and hour', () => {
            const cron = CronExpression.parse('30 10 * * *');
            expect(cron.matches(monday)).toBe(true);
            expect(cron.matches(new Date('2026-06-15T08:31:00Z'))).toBe(false);
            expect(cron.matches(new Date('2026-06-15T09:30:00Z'))).toBe(false);
        });

        test('matches lists, ranges and steps', () => {
            expect(CronExpression.parse('0,30 10 * * *').matches(new Date('2026-06-15T08:00:00Z'))).toBe(true);
            // 05:00 UTC = 07:00 Warsaw - outside 8-12
            expect(CronExpression.parse('0 8-12 * * *').matches(new Date('2026-06-15T05:00:00Z'))).toBe(false);
            // 06:00 UTC = 08:00 Warsaw - inside 8-12
            expect(CronExpression.parse('0 8-12 * * *').matches(new Date('2026-06-15T06:00:00Z'))).toBe(true);
            expect(CronExpression.parse('*/15 * * * *').matches(new Date('2026-06-15T08:45:00Z'))).toBe(true);
            expect(CronExpression.parse('*/15 * * * *').matches(new Date('2026-06-15T08:50:00Z'))).toBe(false);
        });

        test('day-of-week: 0 and 7 both mean Sunday', () => {
            expect(CronExpression.parse('30 10 * * 0').matches(sunday)).toBe(true);
            expect(CronExpression.parse('30 10 * * 7').matches(sunday)).toBe(true);
            expect(CronExpression.parse('30 10 * * 1').matches(sunday)).toBe(false);
            expect(CronExpression.parse('30 10 * * 1').matches(monday)).toBe(true);
        });

        test('day-of-month restriction', () => {
            expect(CronExpression.parse('30 10 15 * *').matches(monday)).toBe(true);
            expect(CronExpression.parse('30 10 1 * *').matches(monday)).toBe(false);
        });

        test('dom and dow restricted combine with OR (vixie-cron)', () => {
            expect(CronExpression.parse('30 10 15 * 1').matches(monday)).toBe(true);
            const notMondayNot15th = new Date('2026-06-16T08:30:00Z');
            expect(CronExpression.parse('30 10 15 * 1').matches(notMondayNot15th)).toBe(false);
        });

        test('month restriction', () => {
            expect(CronExpression.parse('30 10 * 6 *').matches(monday)).toBe(true);
            expect(CronExpression.parse('30 10 * 7 *').matches(monday)).toBe(false);
        });
    });

    describe('next', () => {
        test('every 15 minutes', () => {
            const cron = CronExpression.parse('*/15 * * * *');
            const from = new Date('2026-06-15T08:02:00Z');
            const next = cron.next(from)!;
            expect(next.toISOString()).toBe('2026-06-15T08:15:00.000Z');

            const next2 = cron.next(next)!;
            expect(next2.toISOString()).toBe('2026-06-15T08:30:00.000Z');
        });

        test('strictly after `from` (same-minute from does not match)', () => {
            const cron = CronExpression.parse('30 10 * * *');
            const from = new Date('2026-06-15T08:30:00Z');
            const next = cron.next(from)!;
            expect(next.toISOString()).toBe('2026-06-16T08:30:00.000Z');
        });

        test('weekly schedule', () => {
            const cron = CronExpression.parse('0 0 * * 1');
            const from = new Date('2026-06-15T10:00:00Z'); // Monday after 00:00
            const next = cron.next(from)!;
            // Next Monday is 2026-06-22, 00:00 Warsaw = 22:00 UTC (previous day)
            expect(next.toISOString()).toBe('2026-06-21T22:00:00.000Z');
        });

        test('leap day fires only in leap years', () => {
            const cron = CronExpression.parse('0 0 29 2 *');
            const from = new Date('2026-06-15T00:00:00Z');
            const next = cron.next(from)!;
            // 2028-02-29 00:00 Warsaw = 2028-02-28 23:00 UTC
            expect(next.getUTCFullYear()).toBe(2028);
            expect(next.getUTCMonth()).toBe(1);
            expect(next.getUTCDate()).toBe(28);
            expect(next.getUTCHours()).toBe(23);
        });

        test('yearly schedule', () => {
            const cron = CronExpression.parse('0 0 1 1 *');
            const from = new Date('2026-06-15T00:00:00Z');
            const next = cron.next(from)!;
            // 2027-01-01 00:00 Warsaw = 2026-12-31 23:00 UTC
            expect(next.getUTCFullYear()).toBe(2026);
            expect(next.getUTCMonth()).toBe(11);
            expect(next.getUTCDate()).toBe(31);
            expect(next.getUTCHours()).toBe(23);
        });

        test('returns null beyond the 4-year horizon', () => {
            const cron = CronExpression.parse('0 0 30 2 *'); // Feb 30 never exists
            expect(cron.next(new Date('2026-06-15T00:00:00Z'))).toBeNull();
        });

        test('DST spring-forward gap is skipped (Warsaw 2026-03-29, 02:00 does not exist)', () => {
            const cron = CronExpression.parse('30 2 * * *');
            // 2026-03-28 12:00 UTC -> next 02:30 wall time. On 2026-03-29 the
            // wall clock jumps 02:00 -> 03:00, so 02:30 does not exist that day.
            const from = new Date('2026-03-28T12:00:00Z');
            const next = cron.next(from)!;
            // Must land on 2026-03-30 02:30 CEST (= 00:30 UTC), not on the gap.
            expect(next.toISOString()).toBe('2026-03-30T00:30:00.000Z');
            expect(cron.matches(new Date('2026-03-29T01:30:00Z'))).toBe(false);
        });

        test('DST fall-back overlap matches at both UTC instants (Warsaw 2026-10-25)', () => {
            const cron = CronExpression.parse('30 2 * * *');
            // On 2026-10-25 wall time 02:30 occurs twice: 00:30 UTC (CEST) and
            // 01:30 UTC (CET). Both instants must match.
            const first = new Date('2026-10-25T00:30:00Z');
            const second = new Date('2026-10-25T01:30:00Z');
            expect(cron.matches(first)).toBe(true);
            expect(cron.matches(second)).toBe(true);
        });

        test('next() does not skip occurrences inside the fall-back overlap', () => {
            // Warsaw 2026-10-25, overlap hour 00:00-01:00 UTC (wall 02:00-03:00).
            const cron = CronExpression.parse('*/10 * * * *');

            // Minutes of the FIRST overlap pass must not be jumped over.
            const next = cron.next(new Date('2026-10-25T00:05:00Z'))!;
            expect(next.toISOString()).toBe('2026-10-25T00:10:00.000Z');

            // Mid-minute `from` inside the first pass still returns the second
            // instant of the SAME wall minute (01:30Z), not the next minute.
            const second = CronExpression.parse('30 2 * * *').next(new Date('2026-10-25T00:30:30Z'))!;
            expect(second.toISOString()).toBe('2026-10-25T01:30:00.000Z');
        });

        test('wallClockKey is stable across the DST overlap', () => {
            const cron = CronExpression.parse('30 2 * * *');
            const first = new Date('2026-10-25T00:30:00Z');
            const second = new Date('2026-10-25T01:30:00Z');
            expect(cron.wallClockKey(first)).toBe(cron.wallClockKey(second));
            expect(cron.wallClockKey(first)).toBe('2026-10-25 02:30');
        });
    });

    test('default timezone is Europe/Warsaw', () => {
        expect(CRON_DEFAULT_TIMEZONE).toBe('Europe/Warsaw');
        expect(CronExpression.parse('* * * * *').getTimeZone()).toBe('Europe/Warsaw');
        expect(CronExpression.parse('* * * * *', 'UTC').getTimeZone()).toBe('UTC');
    });
});