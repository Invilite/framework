import http from "http";
import {Socket} from "net";
import express, {Express} from "express";
import {requestUrlOf, upgradeClientAddressOf} from "../../src/infrastructure/Server/http/middleware/CoreMiddleware";

const ORIGIN: string = 'https://example.com';

describe('requestUrlOf', () => {
    it('keeps the path and query of an origin-form target', () => {
        expect(requestUrlOf('/articles?page=2', ORIGIN).href).toBe('https://example.com/articles?page=2');
    });

    it('ignores the scheme and host of an absolute-form target', () => {
        expect(requestUrlOf('http://evil.example/x?y=1', ORIGIN).href).toBe('https://example.com/x?y=1');
    });

    it('ignores the host of a protocol-relative target', () => {
        expect(requestUrlOf('//evil.example/x', ORIGIN).origin).toBe(ORIGIN);
    });

    it('falls back to the origin when the target cannot be parsed', () => {
        expect(requestUrlOf('//[::1]:bad/x', ORIGIN).href).toBe('https://example.com/');
    });
});

describe('upgradeClientAddressOf', () => {
    function upgradeRequest(headers: http.IncomingHttpHeaders, remoteAddress: string): http.IncomingMessage {
        return {headers, socket: {remoteAddress} as Socket} as http.IncomingMessage;
    }

    it('follows X-Forwarded-For only when the application trusts the proxy', () => {
        const trusting: Express = express();
        trusting.set('trust proxy', true);
        const direct: Express = express();
        direct.set('trust proxy', false);
        const request: http.IncomingMessage = upgradeRequest({'x-forwarded-for': '203.0.113.9'}, '10.0.0.1');

        expect(upgradeClientAddressOf(trusting, request, false)).toBe('203.0.113.9');
        expect(upgradeClientAddressOf(direct, request, false)).toBe('10.0.0.1');
    });

    it('reads CF-Connecting-IP only when Cloudflare is trusted', () => {
        const application: Express = express();
        application.set('trust proxy', false);
        const request: http.IncomingMessage = upgradeRequest({'cf-connecting-ip': '198.51.100.4'}, '10.0.0.1');

        expect(upgradeClientAddressOf(application, request, true)).toBe('198.51.100.4');
        expect(upgradeClientAddressOf(application, request, false)).toBe('10.0.0.1');
    });
});
