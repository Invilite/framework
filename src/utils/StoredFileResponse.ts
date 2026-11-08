import express from 'express';
import {pipeline, Readable} from 'stream';
import {ExtendedRequest} from '../models/ExtendedRequest';

export interface StoredFileResponseOptions {
    stream: Readable;
    size: number;
    contentType: string;
    cacheControl: string;
    contentDisposition?: string;
    headers?: Record<string, string>;
}

/**
 * Wysyła strumień z prywatnego magazynu z nagłówkami wybranej domeny. Kontroler nie może
 * zwrócić strumienia przez `@Render`/JSON, więc odpowiedź przejmuje pipeline, a `selfResponding`
 * chroni ją przed zamianą na 204 przez requestHandler.
 */
export class StoredFileResponse {
    public static async send(
        request: ExtendedRequest,
        response: express.Response,
        options: StoredFileResponseOptions,
    ): Promise<void> {
        response.setHeader('Content-Type', options.contentType);
        response.setHeader('Content-Length', String(options.size));
        response.setHeader('Cache-Control', options.cacheControl);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Disposition', options.contentDisposition ?? 'inline');
        for (const [name, value] of Object.entries(options.headers ?? {})) {
            response.setHeader(name, value);
        }

        response.status(200);
        request.selfResponding = true;

        await new Promise<void>((resolve): void => {
            pipeline(options.stream, response, (error?: NodeJS.ErrnoException | null): void => {
                if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                    request.logger?.error('Stored file stream failed:', error);
                }
                resolve();
            });
        });
    }
}

export default StoredFileResponse;
