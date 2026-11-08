
export default interface HttpRequestReceivedEvent {
    method: string;
    path: string;
    url: URL;
    requestId: string;
    clientAddress?: string;
    userAgent?: string;
    referrer?: string;
    headers: Record<string, string | string[] | undefined>;
    cookies: Record<string, string>;
    signedCookies: Record<string, string>;
}