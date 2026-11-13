import http from "http";
import {AddressInfo} from "net";
import express, {Express, Request, Response} from "express";
import EventBus from "@invilite/eventbus";
import {CoreMiddleware} from "../../src/infrastructure/Server/http/middleware/CoreMiddleware";
import {TrustProxy} from "../../src/infrastructure/Server/WebServerOptions";
import HttpRequestReceivedEvent from "../../src/types/interfaces/HttpRequestReceivedEvent";

interface SeenAddresses {
    requestIp: string;
    eventAddress: string | undefined;
}

async function addressesSeenByRoute(trustProxy: TrustProxy, trustCloudflare: boolean, headers: Record<string, string>): Promise<SeenAddresses> {
    const eventBus: EventBus = new EventBus();
    let eventAddress: string | undefined;
    eventBus.on('http.request.received', (payload: HttpRequestReceivedEvent): void => {
        eventAddress = payload.clientAddress;
    });

    const application: Express = express();
    application.set('trust proxy', trustProxy);
    application.use(CoreMiddleware(eventBus, trustCloudflare));
    application.get('/', (request: Request, response: Response): void => {
        response.send(request.ip ?? '');
    });

    const server: http.Server = await new Promise((resolve: (server: http.Server) => void): void => {
        const listening: http.Server = application.listen(0, '127.0.0.1', (): void => resolve(listening));
    });

    try {
        const port: number = (server.address() as AddressInfo).port;
        const response: globalThis.Response = await fetch(`http://127.0.0.1:${port}/`, {headers});
        return {requestIp: await response.text(), eventAddress};
    } finally {
        await new Promise<void>((resolve: () => void): void => {
            server.close((): void => resolve());
        });
    }
}

describe('CoreMiddleware client address', () => {
    const originalHostName: string | undefined = process.env.HOST_NAME;

    beforeAll(() => {
        process.env.HOST_NAME = 'https://example.com';
    });

    afterAll(() => {
        process.env.HOST_NAME = originalHostName;
    });

    it('gives the route the Cloudflare client address in request.ip, not the proxy chain', async () => {
        const seen: SeenAddresses = await addressesSeenByRoute(true, true, {
            'CF-Connecting-IP': '198.51.100.4',
            'X-Forwarded-For': '192.0.2.50',
        });

        expect(seen.requestIp).toBe('198.51.100.4');
    });

    it('follows the trust proxy chain in request.ip when Cloudflare is not trusted', async () => {
        const seen: SeenAddresses = await addressesSeenByRoute('loopback', false, {
            'CF-Connecting-IP': '198.51.100.4',
            'X-Forwarded-For': '203.0.113.7, 192.0.2.10',
        });

        expect(seen.requestIp).toBe('192.0.2.10');
    });

    it('never puts something that is not an address into request.ip', async () => {
        const seen: SeenAddresses = await addressesSeenByRoute(true, false, {'X-Forwarded-For': 'not-an-address'});

        expect(seen.requestIp).toMatch(/127\.0\.0\.1$/);
    });

    it('announces the same address in the request event as the route reads from request.ip', async () => {
        const seen: SeenAddresses = await addressesSeenByRoute(true, true, {
            'CF-Connecting-IP': '2001:db8::4',
            'X-Forwarded-For': '192.0.2.50',
        });

        expect(seen.requestIp).toBe('2001:db8::4');
        expect(seen.eventAddress).toBe(seen.requestIp);
    });
});
