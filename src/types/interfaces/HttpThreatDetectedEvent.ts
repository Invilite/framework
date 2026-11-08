import HttpThreatCategory from '../enums/HttpThreatCategory';

export const HTTP_THREAT_DETECTED_EVENT: string = 'http.threat.detected';

export type HttpThreatInput =
    | 'path'
    | 'query'
    | 'user-agent'
    | 'referer'
    | 'method'
    | 'host'
    | 'origin'
    | 'client-hints';

export interface HttpThreat {
    category: HttpThreatCategory;
    rule: string;
    input: HttpThreatInput;
}

export default interface HttpThreatDetectedEvent {
    requestId: string;
    clientAddress?: string;
    method: string;
    host?: string;
    targetOrigin?: string;
    path: string;
    query: string;
    userAgent?: string;
    claimedUserAgent?: string;
    clientHints?: string;
    referer?: string;
    statusCode: number;
    aborted: boolean;
    threats: HttpThreat[];
}
