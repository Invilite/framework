/**
 * Redirect targets taken from user input (`?redirect=`) - only a path on this site passes, everything else
 * (another host, `//host`, `/\host`, a scheme like `javascript:`) falls back.
 */
export class SafeRedirect {
    private static readonly BASE: string = 'http://local.invalid';

    /** Returns `pathname + search + hash` of a same-site path, or `fallback`. */
    public static localPath(value: unknown, fallback: string): string {
        if (typeof value !== 'string' || !SafeRedirect.isSitePath(value)) {
            return fallback;
        }
        // Control characters (tab, newline) are stripped by URL parsers, so "/\t/evil.com" would become "//evil.com".
        for (let i: number = 0; i < value.length; i++) {
            const code: number = value.charCodeAt(i);
            if (code < 0x20 || code === 0x7f) {
                return fallback;
            }
        }

        let url: URL;
        try {
            url = new URL(value, SafeRedirect.BASE);
        } catch {
            return fallback;
        }
        if (url.origin !== SafeRedirect.BASE) {
            return fallback;
        }

        const localPath: string = `${url.pathname}${url.search}${url.hash}`;
        return SafeRedirect.isSitePath(localPath) ? localPath : fallback;
    }

    private static isSitePath(value: string): boolean {
        return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\');
    }
}
