import {CookieOptions, Request, Response} from "express";
import {SessionConfig} from "./SessionTypes";

/**
 * The only place that knows the names and options of the session cookies. Lifetimes come from the token TTLs,
 * so a cookie can never be configured apart from the token it carries.
 */
export class SessionCookies {
    public constructor(private readonly config: SessionConfig) {}

    public setAccess(response: Response, token: string): void {
        response.cookie(this.config.cookies.accessName, token, this.options(this.config.accessTtlSeconds * 1000));
    }

    public setRefresh(response: Response, token: string): void {
        response.cookie(this.config.cookies.refreshName, token, this.options(this.config.refreshTtlSeconds * 1000));
    }

    public clear(response: Response): void {
        response.cookie(this.config.cookies.refreshName, '', this.options(0));
        response.cookie(this.config.cookies.accessName, '', this.options(0));
    }

    /** Lifetime of the access cookie in milliseconds (scripts schedule their next refresh from it). */
    public accessMaxAge(): number {
        return this.config.accessTtlSeconds * 1000;
    }

    public readAccess(request: Request): string | undefined {
        return SessionCookies.read(request, this.config.cookies.accessName);
    }

    public readRefresh(request: Request): string | undefined {
        return SessionCookies.read(request, this.config.cookies.refreshName);
    }

    /** False for the fake response of a WebSocket upgrade - such a request cannot receive cookies. */
    public static canWrite(response: Response): boolean {
        return typeof (response as Partial<Response>).cookie === 'function';
    }

    private options(maxAge: number): CookieOptions {
        return {
            httpOnly: true,
            secure: this.config.cookies.secure,
            signed: true,
            sameSite: this.config.cookies.sameSite,
            path: this.config.cookies.path,
            maxAge,
        };
    }

    private static read(request: Request, name: string): string | undefined {
        // A signed cookie with a broken signature is `false`, not a string.
        const value: unknown = request.signedCookies?.[name];
        return typeof value === 'string' && value !== '' ? value : undefined;
    }
}
