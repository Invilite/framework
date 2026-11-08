
export class String {

    public static capitalizeFirstLetter(str: string): string {
        if (!str) {
            return '';
        }

        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    /**
     * Normalizes free multi-line text before saving, so whitespace cannot be used to blow up the layout
     * ("half a page of Enters"): CRLF/CR -> LF, spaces/tabs at the start and end of every line removed,
     * a run of more than 3 spaces/tabs inside a line -> one space, 2+ consecutive line breaks -> one blank
     * line (paragraphs survive), the whole text trimmed. Example: "a  \n\n\n  b" -> "a\n\nb".
     */
    public static normalizeMultiline(str: string): string {
        if (!str) {
            return '';
        }
        return str
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map((line: string) => line.replace(/[ \t\u00a0]{4,}/g, ' ').trim())
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    public static truncate(str: string, maxLength: number): string {
        if (str.length <= maxLength) {
            return str;
        }

        return str.slice(0, maxLength);
    }

    /** Truncates by code points (emoji count as one) and appends an ellipsis; shorter text is unchanged. */
    public static ellipsize(str: string, maxCodePoints: number): string {
        const characters: string[] = [...str];
        if (characters.length <= maxCodePoints) {
            return str;
        }

        return characters.slice(0, maxCodePoints).join('') + '…';
    }

    /**
     * Slug URL z dowolnego tekstu: transliteracja diakrytyków (ą→a, ę→e, ł→l…),
     * lowercase, znaki inne niż [a-z0-9] na "-", zwinięcie powtórzeń, obcięcie
     * na granicy "-" (bez wisiącego sufiksu). Pusty wynik = tekst bez znaków
     * alfanumerycznych ( caller podstawia własny fallback).
     */
    public static slug(value: string, maxLength: number = 80): string {
        const transliterationMap: Record<string, string> = {
            'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o',
            'ś': 's', 'ź': 'z', 'ż': 'z',
            'ä': 'a', 'ö': 'o', 'ü': 'u', 'ß': 'ss',
            'é': 'e', 'è': 'e', 'ê': 'e', 'à': 'a', 'â': 'a', 'ç': 'c',
            'ñ': 'n', 'á': 'a', 'í': 'i', 'ú': 'u',
        };

        const transliterated: string = value
            .toLowerCase()
            .replace(/[ąćęłńóśźżäöüßéèêàâçñáíú]/g, (char: string): string => transliterationMap[char] ?? char);

        const slugified: string = transliterated
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/-{2,}/g, '-')
            .replace(/^-+|-+$/g, '');

        if (slugified.length <= maxLength) {
            return slugified;
        }

        const truncated: string = slugified.slice(0, maxLength + 1);
        const lastSeparator: number = truncated.lastIndexOf('-');
        return (lastSeparator > 0 ? truncated.slice(0, lastSeparator) : slugified.slice(0, maxLength)).replace(/-+$/g, '');
    }

    /** Segment URL zasobu: "<id>-<slug tytułu>" (np. "64-calosc-poprawiona"); samo "<id>" gdy tytuł nie da znaków. */
    public static idSlug(id: number, title: string, maxLength: number = 80): string {
        const slug: string = String.slug(title, maxLength);
        return slug ? `${id}-${slug}` : id.toString();
    }

    /** Id z segmentu URL w formacie "<id>-<slug>" lub "<id>" (np. "64-calosc" → 64); null gdy format nie pasuje. */
    public static parseIdSlug(value: string): number | null {
        const match: RegExpMatchArray | null = value.match(/^(\d+)(?:-.*)?$/);
        if (!match) {
            return null;
        }
        const id: number = Number(match[1]);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    }

    /** Escapes LIKE/ILIKE wildcards (`% _ \`) so user input matches literally (PostgreSQL's default escape is `\`). */
    public static escapeLike(value: string): string {
        return value.replace(/[\\%_]/g, (match: string): string => "\\" + match);
    }
}
