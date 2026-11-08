import {LookupAddress} from 'node:dns';
import {lookup} from 'node:dns/promises';
import {ClientRequest, IncomingMessage} from 'node:http';
import {request as httpsRequest, RequestOptions} from 'node:https';
import {BlockList, isIP} from 'node:net';

const DEFAULT_ACCEPT: string = 'application/octet-stream';

const BLOCKED_ADDRESSES: BlockList = new BlockList();
BLOCKED_ADDRESSES.addSubnet('0.0.0.0', 8, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('10.0.0.0', 8, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('100.64.0.0', 10, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('172.16.0.0', 12, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('192.0.0.0', 24, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('192.0.2.0', 24, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('192.168.0.0', 16, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('198.18.0.0', 15, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('198.51.100.0', 24, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('203.0.113.0', 24, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('224.0.0.0', 4, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('240.0.0.0', 4, 'ipv4');
BLOCKED_ADDRESSES.addAddress('::', 'ipv6');
BLOCKED_ADDRESSES.addAddress('::1', 'ipv6');
BLOCKED_ADDRESSES.addSubnet('100::', 64, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('2001::', 32, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('::ffff:0:0:0', 96, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('2001:db8::', 32, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('64:ff9b:1::', 48, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('fc00::', 7, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('fec0::', 10, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('ff00::', 8, 'ipv6');

export interface SafeHttpsAddress {
    address: string;
    family: number;
}

export type SafeHttpsResolver = (hostname: string) => Promise<SafeHttpsAddress[]>;

export interface SafeHttpsRequest {
    url: string;
    hostname: string;
    port: string;
    path: string;
    address: string;
    family: number;
    timeoutMs: number;
    maxBytes: number;
    signal: AbortSignal;
    accept?: string;
    ca?: string | Buffer;
}

export interface SafeHttpsResponse {
    statusCode: number;
    body: Buffer;
}

export type SafeHttpsTransport = (request: SafeHttpsRequest) => Promise<SafeHttpsResponse>;

export interface SafeHttpsTransportMessages {
    timeout: string;
    tooLarge: string;
}

export interface SafeHttpsFetcherOptions {
    context: string;
    resolver?: SafeHttpsResolver;
    transport?: SafeHttpsTransport;
    sizeLimitMessage?: (maxBytes: number) => string;
}

export interface SafeHttpsFetchRequest {
    url: string;
    allowedHosts: readonly string[] | null;
    allowedPorts?: readonly string[];
    timeoutMs: number;
    maxBytes: number;
    accept?: string;
}

async function resolveWithDns(hostname: string): Promise<SafeHttpsAddress[]> {
    const records: LookupAddress[] = await lookup(hostname, {all: true});

    return records.map((record: LookupAddress): SafeHttpsAddress => ({
        address: record.address,
        family: record.family,
    }));
}

/** HTTPS transport with a pinned DNS answer. Exported so transport-level tests can exercise it directly. */
export function requestSafeHttps(
    request: SafeHttpsRequest,
    messages: SafeHttpsTransportMessages,
): Promise<SafeHttpsResponse> {
    return new Promise<SafeHttpsResponse>((resolve, reject): void => {
        let settled: boolean = false;
        let outgoing: ClientRequest | null = null;

        const settle = (error: Error | null, response: SafeHttpsResponse | null = null): void => {
            if (settled) {
                return;
            }
            settled = true;
            request.signal.removeEventListener('abort', abortHandler);

            if (error) {
                reject(error);
                return;
            }
            if (response) {
                resolve(response);
                return;
            }
            reject(new Error('Safe HTTPS request produced no response'));
        };

        const abortHandler = (): void => {
            outgoing?.destroy();
            settle(new Error(messages.timeout));
        };

        const options: RequestOptions = {
            protocol: 'https:',
            hostname: request.hostname,
            port: request.port,
            path: request.path,
            method: 'GET',
            headers: {accept: request.accept ?? DEFAULT_ACCEPT},
            timeout: request.timeoutMs,
            ca: request.ca,
            // Pinning the vetted address prevents a second DNS answer from redirecting the connection (DNS rebinding).
            lookup: (_hostname, lookupOptions, callback): void => {
                if (lookupOptions.all) {
                    callback(null, [{address: request.address, family: request.family}]);
                    return;
                }
                callback(null, request.address, request.family);
            },
        };

        outgoing = httpsRequest(options, (response: IncomingMessage): void => {
            const chunks: Buffer[] = [];
            let receivedBytes: number = 0;

            response.on('data', (chunk: Buffer): void => {
                receivedBytes += chunk.length;
                if (receivedBytes > request.maxBytes) {
                    response.destroy();
                    outgoing?.destroy();
                    settle(new Error(messages.tooLarge));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', (): void => {
                settle(null, {
                    statusCode: response.statusCode ?? 0,
                    body: Buffer.concat(chunks),
                });
            });
            response.on('error', (error: Error): void => settle(error));
        });

        outgoing.on('timeout', (): void => {
            outgoing?.destroy();
            settle(new Error(messages.timeout));
        });
        outgoing.on('error', (error: Error): void => settle(error));

        if (request.signal.aborted) {
            abortHandler();
            return;
        }
        request.signal.addEventListener('abort', abortHandler, {once: true});
        outgoing.end();
    });
}

function waitForDeadline<T>(operation: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
    return new Promise<T>((resolve, reject): void => {
        const onAbort = (): void => reject(new Error(message));
        if (signal.aborted) {
            onAbort();
            return;
        }

        signal.addEventListener('abort', onAbort, {once: true});
        operation.then(
            (value: T): void => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown): void => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

function parseIpv6Groups(part: string): number[] | null {
    if (part.length === 0) {
        return [];
    }

    const groups: number[] = [];
    for (const group of part.split(':')) {
        if (group.length === 0) {
            return null;
        }

        if (group.includes('.')) {
            const octets: string[] = group.split('.');
            if (octets.length !== 4 || octets.some((octet: string): boolean => !/^\d{1,3}$/.test(octet))) {
                return null;
            }

            const values: number[] = octets.map((octet: string): number => Number(octet));
            if (values.some((value: number): boolean => value > 255)) {
                return null;
            }

            groups.push((values[0] << 8) | values[1], (values[2] << 8) | values[3]);
        } else {
            if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
                return null;
            }
            groups.push(parseInt(group, 16));
        }
    }

    return groups;
}

function ipv6Bytes(address: string): number[] | null {
    const zoneIndex: number = address.indexOf('%');
    const value: string = zoneIndex >= 0 ? address.slice(0, zoneIndex) : address;
    const compression: number = value.indexOf('::');
    const head: string = compression >= 0 ? value.slice(0, compression) : value;
    const tail: string = compression >= 0 ? value.slice(compression + 2) : '';
    const headGroups: number[] | null = parseIpv6Groups(head);
    const tailGroups: number[] | null = parseIpv6Groups(tail);

    if (!headGroups || !tailGroups) {
        return null;
    }

    const missing: number = 8 - headGroups.length - tailGroups.length;
    if (compression >= 0 ? missing < 1 : missing !== 0) {
        return null;
    }

    const groups: number[] = [...headGroups, ...new Array<number>(Math.max(missing, 0)).fill(0), ...tailGroups];
    const bytes: number[] = [];
    for (const group of groups) {
        bytes.push((group >> 8) & 0xff, group & 0xff);
    }

    return bytes;
}

function ipv4FromBytes(bytes: number[], offset: number): string {
    return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function isBlockedIpv4(address: string): boolean {
    return BLOCKED_ADDRESSES.check(address, 'ipv4');
}

export function isPublicAddress(address: string): boolean {
    const family: number = isIP(address);
    if (family === 4) {
        return !isBlockedIpv4(address);
    }
    if (family !== 6) {
        return false;
    }
    if (BLOCKED_ADDRESSES.check(address, 'ipv6')) {
        return false;
    }

    const bytes: number[] | null = ipv6Bytes(address);
    if (!bytes) {
        return false;
    }

    // IPv4-compatible, 6to4 and NAT64 forms embed an IPv4 address, so the embedded value needs the same check.
    const isMapped: boolean = bytes.slice(0, 10).every((byte: number): boolean => byte === 0)
        && bytes[10] === 0xff
        && bytes[11] === 0xff;
    const isCompatible: boolean = bytes.slice(0, 12).every((byte: number): boolean => byte === 0);
    if (isMapped || isCompatible) {
        return !isBlockedIpv4(ipv4FromBytes(bytes, 12));
    }
    if (bytes[0] === 0x20 && bytes[1] === 0x02) {
        return !isBlockedIpv4(ipv4FromBytes(bytes, 2));
    }
    const isNat64: boolean = bytes[0] === 0x00
        && bytes[1] === 0x64
        && bytes[2] === 0xff
        && bytes[3] === 0x9b
        && bytes.slice(4, 12).every((byte: number): boolean => byte === 0);
    if (isNat64) {
        return !isBlockedIpv4(ipv4FromBytes(bytes, 12));
    }

    return true;
}

/** Fetches one HTTPS resource, refusing hosts outside an allowlist, non-public addresses and oversized bodies. */
export class SafeHttpsFetcher {
    private readonly resolver: SafeHttpsResolver;
    private readonly transport: SafeHttpsTransport;
    private readonly sizeLimitMessage: (maxBytes: number) => string;

    public constructor(private readonly options: SafeHttpsFetcherOptions) {
        this.resolver = options.resolver ?? resolveWithDns;
        this.sizeLimitMessage = options.sizeLimitMessage ?? ((maxBytes: number): string =>
            `${options.context} response exceeds ${maxBytes} bytes`);
        this.transport = options.transport ?? ((request: SafeHttpsRequest): Promise<SafeHttpsResponse> =>
            requestSafeHttps(request, {
                timeout: `${options.context} request timed out`,
                tooLarge: this.sizeLimitMessage(request.maxBytes),
            }));
    }

    public async fetch(request: SafeHttpsFetchRequest): Promise<SafeHttpsResponse> {
        let url: URL;
        try {
            url = new URL(request.url);
        } catch {
            throw new Error(`${this.options.context} URL is not a valid URL`);
        }

        if (url.protocol !== 'https:') {
            throw new Error(`${this.options.context} URL must use HTTPS`);
        }
        if (url.username.length > 0 || url.password.length > 0) {
            throw new Error(`${this.options.context} URL must not contain credentials`);
        }
        if (url.hash.length > 0) {
            throw new Error(`${this.options.context} URL must not contain a fragment`);
        }

        const hostname: string = url.hostname.replace(/^\[|\]$/g, '');
        const port: string = url.port.length > 0 ? url.port : '443';
        if (request.allowedHosts !== null
            && !request.allowedHosts.some((allowed: string): boolean => allowed.toLowerCase() === hostname.toLowerCase())) {
            throw new Error(`${this.options.context} host is not allowed`);
        }
        if (request.allowedPorts !== undefined && !request.allowedPorts.includes(port)) {
            throw new Error(`${this.options.context} port is not allowed`);
        }

        const controller: AbortController = new AbortController();
        const deadline: NodeJS.Timeout = setTimeout((): void => controller.abort(), request.timeoutMs);
        const timeoutMessage: string = `${this.options.context} request timed out`;

        try {
            const addresses: SafeHttpsAddress[] = await waitForDeadline(
                this.resolver(hostname),
                controller.signal,
                timeoutMessage,
            );
            if (addresses.length === 0) {
                throw new Error(`${this.options.context} host did not resolve to any address`);
            }
            if (addresses.some((entry: SafeHttpsAddress): boolean => !isPublicAddress(entry.address))) {
                throw new Error(`${this.options.context} host resolves to a non-public address`);
            }

            const selected: SafeHttpsAddress = addresses[0];
            const response: SafeHttpsResponse = await waitForDeadline(this.transport({
                url: request.url,
                hostname,
                port,
                path: `${url.pathname}${url.search}`,
                address: selected.address,
                family: selected.family,
                timeoutMs: request.timeoutMs,
                maxBytes: request.maxBytes,
                accept: request.accept,
                signal: controller.signal,
            }), controller.signal, timeoutMessage);

            if (response.body.length > request.maxBytes) {
                throw new Error(this.sizeLimitMessage(request.maxBytes));
            }

            return response;
        } finally {
            clearTimeout(deadline);
        }
    }
}
