
export class DateTime {
    private static readonly MONTHS_PL: string[] = [
        'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
        'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
    ];

    /** Polish month name in genitive; `month` is 0-based like `Date.getMonth()`. */
    public static monthGenitive(month: number): string {
        return DateTime.MONTHS_PL[month];
    }

    /** Data długa po polsku, np. "12 marca 2026, 14:32". */
    public static DateLong(date: Date): string {
        const day: number = date.getDate();
        const month: string = DateTime.monthGenitive(date.getMonth());
        const hh: string = date.getHours().toString().padStart(2, '0');
        const mm: string = date.getMinutes().toString().padStart(2, '0');
        return `${day} ${month} ${date.getFullYear()}, ${hh}:${mm}`;
    }

    /**
     * Względny czas po polsku: "przed chwilą" / "X min temu" / "X godz. temu" /
     * "wczoraj" / "X dni temu" / "DD.MM.YYYY". `timeZone` ustawia strefę daty w ostatnim wariancie.
     */
    public static TimeAgo(date: Date | null, now: Date = new Date(), timeZone?: string): string {
        if (!date) {
            return '';
        }
        const diffMs: number = now.getTime() - date.getTime();
        const min: number = Math.floor(diffMs / 60_000);

        if (min < 1) {
            return 'przed chwilą';
        }
        if (min < 60) {
            return `${min} min temu`;
        }

        const hours: number = Math.floor(min / 60);
        if (hours < 24) {
            return `${hours} godz. temu`;
        }

        const days: number = Math.floor(hours / 24);
        if (days === 1) {
            return 'wczoraj';
        }
        if (days < 7) {
            return `${days} dni temu`;
        }

        const parts: {day: string; month: string; year: string} = DateTime.calendarParts(date, timeZone);
        return `${parts.day}.${parts.month}.${parts.year}`;
    }

    private static calendarParts(date: Date, timeZone?: string): {day: string; month: string; year: string} {
        if (timeZone === undefined) {
            return {
                day: date.getDate().toString().padStart(2, '0'),
                month: (date.getMonth() + 1).toString().padStart(2, '0'),
                year: String(date.getFullYear()),
            };
        }
        const parts: Intl.DateTimeFormatPart[] = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(date);
        const value: (type: Intl.DateTimeFormatPartTypes) => string = (type: Intl.DateTimeFormatPartTypes): string =>
            parts.find((part: Intl.DateTimeFormatPart): boolean => part.type === type)?.value ?? '';
        return {day: value('day'), month: value('month'), year: value('year')};
    }

    public static Format(date: Date, format: string): string {
        return format.replace(/[A-Za-z]{1,2}/g, (part: string): string => {
            switch (part) {
                case 'Y':
                    return date.getFullYear().toString().slice(-2);

                case 'YY':
                    return String(date.getFullYear());

                case 'M':
                    return String(1 + date.getMonth());

                case 'MM':
                    return `0${1 + date.getMonth()}`.slice(-2);

                case 'D':
                    return String(date.getDate());

                case 'DD':
                    return `0${date.getDate()}`.slice(-2);

                case 'H':
                    return String(date.getHours());

                case 'HH':
                    return `0${date.getHours()}`.slice(-2);

                case 'm':
                    return String(date.getMinutes());

                case 'mm':
                    return `0${date.getMinutes()}`.slice(-2);

                case 's':
                    return String(date.getSeconds());

                case 'ss':
                    return `0${date.getSeconds()}`.slice(-2);

                case 'S':
                    return String(date.getMilliseconds());

                case 'SS':
                    return `00${date.getSeconds()}`.slice(-3);

                case 'z':
                    return String(date.getTimezoneOffset());

                case 'Z':
                    return DateTime.GetTimezoneOffsetString(date);

                default:
                    return part.slice(part.length); // unknown code, remove
            }
        });
    }

    public static GetTimezoneOffsetString(date: Date): string {
        const offset: number = date.getTimezoneOffset();
        const hours: string = Math.floor(Math.abs(offset / 60)).toString().padStart(2, "0");
        const minutes: string = Math.floor(Math.abs(offset % 60)).toString().padStart(2, "0");

        return `${(offset <= 0 ? '+' : '-')}${hours}:${minutes}`;
    }
}
