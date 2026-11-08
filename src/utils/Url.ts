export class Url {
    /**
     * Joins URL parts with exactly one "/" between them. Keeps the scheme (`https://`), a leading "/" of a
     * host-relative first part and a trailing "/" of the last part; collapses repeated slashes in the path,
     * but never inside the query string or hash. Empty, null and undefined parts are skipped.
     */
    public static join(...parts: (string | number | null | undefined)[]): string {
        const items: string[] = parts
            .filter((part) => part !== null && part !== undefined)
            .map((part) => String(part))
            .filter((part: string) => part !== '');
        if (items.length === 0) {
            return '';
        }

        let scheme: string = '';
        const schemeMatch: RegExpMatchArray | null = items[0].match(/^[a-z][a-z0-9+.-]*:\/\//i);
        if (schemeMatch) {
            scheme = schemeMatch[0];
            items[0] = items[0].slice(scheme.length);
        }
        const leadingSlash: boolean = !scheme && items[0].startsWith('/');
        const last: string = items[items.length - 1];
        const trailingSlash: boolean = last.endsWith('/') && !/[?#]/.test(last);

        const core: string = items
            .map((part: string) => part.replace(/^\/+|\/+$/g, ''))
            .filter((part: string) => part !== '')
            .join('/');
        const joined: string = (leadingSlash ? '/' : '') + core + (trailingSlash ? '/' : '');

        const queryAt: number = joined.search(/[?#]/);
        const path: string = queryAt === -1 ? joined : joined.slice(0, queryAt);
        const rest: string = queryAt === -1 ? '' : joined.slice(queryAt);
        return scheme + path.replace(/\/{2,}/g, '/') + rest;
    }

    /** Base URL without trailing slashes (`https://example.com/` -> `https://example.com`). */
    public static trimTrailingSlash(url: string): string {
        return url.replace(/\/+$/, '');
    }
}
