import {ICalendar, IcsCalendar, IcsEvent, IcsEventStatus} from "../../src/utils/ICalendar";

const event: IcsEvent = {
    uid: 'reservation-1@example.com',
    start: new Date('2026-10-20T10:00:00.000Z'),
    end: new Date('2026-10-20T11:30:00.000Z'),
    stamp: new Date('2026-10-08T15:04:05.123Z'),
    summary: 'Spotkanie',
};

const unfold = (ics: string): string => ics.replace(/\r\n /g, '');

describe("ICalendar", () => {
    it("buduje VCALENDAR z liniami zakończonymi CRLF i datami w UTC", () => {
        const ics: string = ICalendar.build({prodId: '-//T//T//PL', events: [event]});
        expect(ics.endsWith('\r\n')).toBe(true);
        expect(ics.split('\r\n').every((line: string) => !line.includes('\n'))).toBe(true);
        expect(ics).toContain('\r\nDTSTART:20261020T100000Z\r\n');
        expect(ics).toContain('\r\nDTEND:20261020T113000Z\r\n');
        expect(ics).toContain('\r\nDTSTAMP:20261008T150405Z\r\n');
        expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//T//PL\r\n')).toBe(true);
    });

    it("METHOD i nagłówki odświeżania tylko gdy podane", () => {
        const feed: string = ICalendar.build({prodId: 'x', name: 'Spotkania', refreshMinutes: 60, events: []});
        expect(feed).not.toContain('METHOD:');
        expect(feed).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
        expect(feed).toContain('X-PUBLISHED-TTL:PT1H');
        expect(feed).toContain('X-WR-CALNAME:Spotkania');
        expect(ICalendar.build({prodId: 'x', method: 'PUBLISH', events: []})).toContain('\r\nMETHOD:PUBLISH\r\n');
    });

    it("escapuje znaki specjalne TEXT", () => {
        expect(ICalendar.escapeText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
    });

    it("zawija linie do 75 oktetów, nie rozcinając polskich znaków ani emoji", () => {
        const summary: string = 'Spotkanie zespołu żółć gęślą jaźń 📅 '.repeat(8);
        const ics: string = ICalendar.build({prodId: 'x', events: [{...event, summary}]});
        for (const line of ics.split('\r\n')) {
            expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
            expect(line).not.toContain('�');
        }
        expect(unfold(ics)).toContain(`SUMMARY:${summary}`);
    });

    it("pomija puste pola opcjonalne", () => {
        const ics: string = ICalendar.build({prodId: 'x', events: [{...event, description: null, location: '', url: null}]});
        expect(ics).not.toMatch(/DESCRIPTION|LOCATION|URL:/);
    });
});


describe("ICalendar - header injection protection", () => {
    const calendarWith = (overrides: Partial<IcsCalendar>): IcsCalendar => ({
        prodId: 'x',
        events: [],
        ...overrides,
    });

    it.each([
        ['PRODID', {prodId: 'x\r\nX-EVIL:1'}],
        ['METHOD', {method: 'PUBLISH\nX-EVIL:1'}],
    ])("rejects control characters in %s", (_property: string, overrides: Partial<IcsCalendar>): void => {
        expect(() => ICalendar.build(calendarWith(overrides))).toThrow(/control characters/);
    });

    it.each([
        ['UID', {uid: 'a\r\nX-EVIL:1'}],
        ['URL', {url: 'https://example.com/event\r\nX-EVIL:1'}],
        ['STATUS', {status: 'CONFIRMED\nX-EVIL:1' as IcsEventStatus}],
    ])("rejects control characters in event %s", (_property: string, overrides: Partial<IcsEvent>): void => {
        expect(() => ICalendar.build({prodId: 'x', events: [{...event, ...overrides}]})).toThrow(/control characters/);
    });

    it("rejects a URL that is not an absolute http(s) URL", (): void => {
        expect(() => ICalendar.build({prodId: 'x', events: [{...event, url: 'javascript:alert(1)'}]}))
            .toThrow(/http\(s\) URL/);
        expect(() => ICalendar.build({prodId: 'x', events: [{...event, url: 'ftp://example.com/x'}]}))
            .toThrow(/http\(s\) URL/);
    });

    it("writes a valid https URL unchanged", (): void => {
        const ics: string = ICalendar.build({
            prodId: 'x',
            events: [{...event, url: 'https://example.com/event?id=1'}],
        });

        expect(ics).toContain('\r\nURL:https://example.com/event?id=1\r\n');
    });
});
