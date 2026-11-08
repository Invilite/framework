/**
 * PostgreSQL cannot store U+0000 in `text` nor `jsonb` (jsonb rejects the `\u0000` escape with
 * "unsupported Unicode escape sequence"), and it rejects lone UTF-16 surrogates (invalid UTF-8) just
 * the same, so a single bad character inside an untrusted value turns the whole INSERT into a 500.
 * Typical source: EXIF/maker-note strings padded with NUL bytes by cameras.
 */
export class NulChar {

    private static readonly LONE_SURROGATE: RegExp =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

    /**
     * Deep copy with NUL characters and lone UTF-16 surrogates removed from every string (values
     * and object keys). Valid surrogate pairs (emoji) are preserved. Recurses only into arrays and
     * plain objects; Date, Buffer, typed arrays and other instances are returned as-is (their JSON
     * form carries no raw strings with NUL).
     */
    public static strip<T>(value: T): T {
        return NulChar.walk(value) as T;
    }

    private static walk(value: unknown): unknown {
        if (typeof value === 'string') {
            return NulChar.sanitize(value);
        }

        if (Array.isArray(value)) {
            return value.map((item: unknown): unknown => NulChar.walk(item));
        }

        if (value !== null && typeof value === 'object') {
            const proto: object | null = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null) {
                return value;
            }

            const result: Record<string, unknown> = {};
            for (const [key, item] of Object.entries(value)) {
                result[NulChar.sanitize(key)] = NulChar.walk(item);
            }

            return result;
        }

        return value;
    }

    private static sanitize(value: string): string {
        return value
            .replace(/\u0000/g, '')
            .replace(NulChar.LONE_SURROGATE, '');
    }
}
