const TONE_MODIFIER_MIN: number = 0x1f3fb;
const TONE_MODIFIER_MAX: number = 0x1f3ff;
const VARIATION_SELECTOR_16: number = 0xfe0f;
const ZERO_WIDTH_JOINER: string = "200d";

/**
 * Normalizacja emoji do klucza pliku: punkty kodowe małymi literami hex,
 * połączone "-", bez selektora wariantu `fe0f`, z `200d`.
 */
export class EmojiKey {

    /**
     * Klucz z tekstu, np. `'❤️'` → `'2764'`, `'🧜🏼‍♀️'` → `'1f9dc-1f3fc-200d-2640'`.
     */
    public static fromChars(text: string): string {
        const key: string[] = [];
        for (const char of text) {
            const codePoint: number | undefined = char.codePointAt(0);
            if (codePoint === undefined || codePoint === VARIATION_SELECTOR_16) {
                continue;
            }
            key.push(codePoint.toString(16));
        }
        return key.join("-");
    }

    /**
     * Klucz z nazwy pliku Noto (`emoji_u1f9dc_1f3fc_200d_2640.png` albo
     * `emoji_u1f1e6_1f1e8.svg`), albo null dla nazw spoza wzorca. Segmenty
     * normalizuje: bez wiodących zer i bez `fe0f`.
     */
    public static fromNotoFile(name: string): string | null {
        const match: RegExpExecArray | null = /^emoji_u([0-9a-f]+(?:_[0-9a-f]+)*)\.(?:png|svg)$/i.exec(name);
        if (match === null) {
            return null;
        }
        const key: string[] = match[1].split("_")
            .map((segment: string): number => parseInt(segment, 16))
            .filter((codePoint: number): boolean => codePoint !== VARIATION_SELECTOR_16)
            .map((codePoint: number): string => codePoint.toString(16));
        return key.length > 0 ? key.join("-") : null;
    }

    /**
     * Znaki dla klucza, bez `fe0f` (alt tekstu i wstawianie do treści).
     */
    public static toChars(key: string): string {
        if (key === "") {
            return "";
        }
        return key.split("-").map((segment: string): string => {
            if (!/^[0-9a-f]+$/i.test(segment)) {
                throw new Error(`Nieprawidłowy klucz emoji: ${key}`);
            }
            const codePoint: number = parseInt(segment, 16);
            if (codePoint > 0x10ffff) {
                throw new Error(`Nieprawidłowy punkt kodowy w kluczu emoji: ${key}`);
            }
            return String.fromCodePoint(codePoint);
        }).join("");
    }

    /**
     * Klucz z domyślnym odcieniem skóry.
     *
     * Usuwa istniejące modyfikatory odcienia (1f3fb–1f3ff) i wstawia `tone` po
     * każdej bazie z `bases` (zbiór `Emoji_Modifier_Base`). Gdy sekwencja ZWJ
     * wymagałaby odcienia po każdej bazie, ale takiego pliku nie ma, próbuje
     * pominąć bazę będącą łącznikiem (np. uścisk dłoni w 🧑‍🤝‍🧑) - wtedy
     * wieloosobowa sekwencja dostaje wspólny odcień.
     *
     * Zwraca wariant z `tone`, gdy jest w `available`; w przeciwnym razie klucz
     * bez modyfikatorów, gdy jest w `available`; w przeciwnym razie wejście.
     */
    public static withTone(key: string, tone: string, available: Set<string>, bases: Set<string>): string {
        const segments: string[] = key.split("-")
            .filter((segment: string): boolean => !EmojiKey.isToneModifier(segment));
        const baseKey: string = segments.join("-");
        const candidates: string[] = [
            EmojiKey.insertTone(segments, tone, bases, false),
            EmojiKey.insertTone(segments, tone, bases, true),
        ];
        for (const candidate of candidates) {
            if (available.has(candidate)) {
                return candidate;
            }
        }
        return available.has(baseKey) ? baseKey : key;
    }

    private static insertTone(segments: string[], tone: string, bases: Set<string>, skipJoiners: boolean): string {
        const result: string[] = [];
        for (let index: number = 0; index < segments.length; index++) {
            const segment: string = segments[index];
            result.push(segment);
            if (!bases.has(segment)) {
                continue;
            }
            const isJoiner: boolean = skipJoiners
                && segments[index - 1] === ZERO_WIDTH_JOINER
                && segments[index + 1] === ZERO_WIDTH_JOINER;
            if (!isJoiner) {
                result.push(tone);
            }
        }
        return result.join("-");
    }

    private static isToneModifier(segment: string): boolean {
        if (!/^[0-9a-f]+$/i.test(segment)) {
            return false;
        }
        const codePoint: number = parseInt(segment, 16);
        return codePoint >= TONE_MODIFIER_MIN && codePoint <= TONE_MODIFIER_MAX;
    }
}
