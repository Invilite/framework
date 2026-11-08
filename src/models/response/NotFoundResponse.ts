/**
 * Sentinel returned by @Render-decorated controller methods to signal "render the 404
 * template with 404 status instead of the decorated template." Recognized by @Render via
 * instanceof (Render.ts). Domain-agnostic: knows only
 * "render this template with this status."
 *
 * Does NOT extend AbstractResponse — different consumption path. AbstractResponse is built
 * around getData(): Buffer for WebServer.requestHandler's JSON/buffer path; NotFoundResponse
 * is consumed by @Render's render path.
 */
export class NotFoundResponse {
    public readonly statusCode: number;
    public readonly template: string;
    public readonly data: Record<string, unknown>;

    public constructor(params: { title: string; template?: string; statusCode?: number }) {
        if (!params.title || params.title.trim().length === 0) {
            throw new RangeError('NotFoundResponse requires a non-empty title');
        }

        this.statusCode = params.statusCode ?? 404;
        if (this.statusCode < 400 || this.statusCode >= 600) {
            throw new RangeError(`NotFoundResponse statusCode must be in 4xx/5xx range, got ${this.statusCode}`);
        }

        this.template = params.template ?? '404';
        if (this.template.trim().length === 0) {
            throw new RangeError('NotFoundResponse requires a non-empty template name');
        }

        this.data = { title: params.title };
    }
}