/**
 * HTTPS redirect URIs are the default; plain HTTP is accepted only for the RFC 8252 loopback
 * addresses used by native applications.
 */
export function isAllowedRedirectUri(value: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }

    if (parsed.hash.length > 0 || parsed.href.endsWith('#') || parsed.username.length > 0 || parsed.password.length > 0) {
        return false;
    }

    if (parsed.protocol === 'https:') {
        return true;
    }

    if (parsed.protocol !== 'http:') {
        return false;
    }

    return isLoopbackHost(parsed);
}

/**
 * Exact match against the registered redirect URIs, except that a registered loopback HTTP URI matches any port:
 * native clients such as CLIs listen on a port picked at runtime (RFC 8252 section 7.3). Scheme, host, path and
 * query must still be identical.
 */
export function isRegisteredRedirectUri(registeredUris: readonly string[], requestedUri: string): boolean {
    if (registeredUris.includes(requestedUri)) {
        return true;
    }

    const requested: URL | null = parseUrl(requestedUri);
    if (!requested || requested.protocol !== 'http:' || !isLoopbackHost(requested)) {
        return false;
    }

    return registeredUris.some((registeredUri: string): boolean => {
        const registered: URL | null = parseUrl(registeredUri);

        return registered !== null
            && registered.protocol === 'http:'
            && isLoopbackHost(registered)
            && registered.hostname === requested.hostname
            && registered.pathname === requested.pathname
            && registered.search === requested.search;
    });
}

function isLoopbackHost(url: URL): boolean {
    const hostname: string = url.hostname.toLowerCase();

    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function parseUrl(value: string): URL | null {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}
