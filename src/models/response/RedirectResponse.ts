/**
 * Sentinel returned by @Render-decorated controller methods to signal "issue an
 * HTTP redirect instead of rendering the decorated template." Recognized by @Render
 * via instanceof (Render.ts), analogous to NotFoundResponse. Domain-agnostic: knows
 * only "redirect to this location with this status."
 * Does NOT extend AbstractResponse — different consumption path. AbstractResponse is
 * built around getData(): Buffer for WebServer.requestHandler's JSON/buffer path;
 * RedirectResponse is consumed by @Render's render path (same reasoning as
 * NotFoundResponse.ts:7-10).
 */
export class RedirectResponse {
    public readonly statusCode: number;
    public readonly location: string;

    public constructor(params: { location: string; statusCode?: number }) {
        if (!params.location || params.location.trim().length === 0) {
            throw new RangeError('RedirectResponse requires a non-empty location');
        }

        this.statusCode = params.statusCode ?? 301;
        if (this.statusCode < 300 || this.statusCode >= 400) {
            throw new RangeError(`RedirectResponse statusCode must be in 3xx range, got ${this.statusCode}`);
        }

        if (this.statusCode === 304 || this.statusCode === 305) {
            throw new RangeError(`RedirectResponse statusCode ${this.statusCode} is not a redirect (304 Not Modified, 305 deprecated)`);
        }

        this.location = params.location;
    }
}