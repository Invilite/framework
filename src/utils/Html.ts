/**
 * HTML escaping for text and attribute values. Escapes `&`, `<`, `>`, `"` and `'` — safe
 * for both element text and quoted attributes.
 */
export class Html {
    public static escape(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** Alias documenting intent; the escaped set is the same as {@link Html.escape}. */
    public static escapeAttr(value: string): string {
        return Html.escape(value);
    }
}
