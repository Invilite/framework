/**
 * Polish noun plural forms: 1 pas, 2-4 pasy, 5+ pasów — including the
 * 12-14 exception (młodsza grupa dziesiątek rządzi jak 5+).
 */
export class PolishPlural {
    public static format(count: number, singular: string, plural24: string, plural5: string): string {
        return `${count} ${PolishPlural.form(count, singular, plural24, plural5)}`;
    }

    public static form(count: number, singular: string, plural24: string, plural5: string): string {
        const abs: number = Math.abs(Math.trunc(count));

        if (abs === 1) {
            return singular;
        }

        const lastDigit: number = abs % 10;
        const lastTwoDigits: number = abs % 100;

        const youth: boolean = lastTwoDigits >= 12 && lastTwoDigits <= 14;
        if (!youth && lastDigit >= 2 && lastDigit <= 4) {
            return plural24;
        }

        return plural5;
    }
}
