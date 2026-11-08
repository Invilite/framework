import {RequestHandler} from "express";
import {IncomingMessage} from "http";
import {ServerResponse} from "node:http";

export function ExpressMiddleware(mw: RequestHandler) {
    return (request: IncomingMessage, response: ServerResponse) => {
        return new Promise<void>((resolve, reject) => {
            const fakeReq: any = request as any;

            fakeReq.get = fakeReq.header = (name: string) => {
                const key: string = name.toLowerCase();
                const value = (request.headers as any)[key];
                // express.get/header zwraca string|undefined (jeśli kilka -> łączone)
                if (Array.isArray(value)) return value.join(',');
                return value;
            };

            fakeReq.protocol = (request.socket && (request.socket as any).encrypted) ? 'https' : 'http';
            fakeReq.secure = fakeReq.protocol === 'https';
            fakeReq.originalUrl = request.url;
            fakeReq.url = request.url;
            fakeReq.baseUrl = '';
            fakeReq.path = request.url?.split('?')[0] ?? '';

            const fakeRes: any = {
                getHeader: (name: string) => undefined,
                setHeader: (_: string, __: unknown) => {},
                header: (_: string, __: unknown) => {},
                writeHead: (_: number, __?: any) => {},
                end: (...args: any[]) => {
                },
                locals: {},
            };

            let called: boolean = false;
            const next = (err?: any) => {
                if (called) return;
                called = true;
                if (err) reject(err);
                else resolve();
            };

            try {
                const result = (mw as any)(fakeReq, fakeRes, next);

                if (result && typeof result.then === 'function') {
                    result.then(() => {
                        if (!called) resolve();
                    }).catch(reject);
                }
            } catch (err) {
                reject(err);
            }
        });
    };
}

export async function RunMiddlewares(request: IncomingMessage, response: ServerResponse, adapted: Array<(request: IncomingMessage, response: ServerResponse) => Promise<void>>): Promise<void> {
    for (const m of adapted) {
        await m(request, response);
    }
}