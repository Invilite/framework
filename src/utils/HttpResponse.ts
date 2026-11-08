import express from 'express';

export class HttpResponse {
    public static notFound(response: express.Response): void {
        if (response.headersSent) {
            return;
        }
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.status(404).end();
    }
}

export default HttpResponse;
