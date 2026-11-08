/** `type:key` - the type picks the channel controller, the key names one channel of that type. */
export interface SocketChannelName {
    type: string;
    key: string;
}

export type SocketClientFrame =
    | {op: 'sub'; ch: string}
    | {op: 'unsub'; ch: string}
    | {op: 'send'; ch: string; t: string; d: unknown; id: string | null}
    | {op: 'ping'};

/** What travels through the broker for one event; `x` names a connection that must not receive it. */
export interface SocketBusEvent {
    t: string;
    d: unknown;
    x: string | null;
}

/**
 * Version 1 of the channel protocol: JSON text frames whose `op` says what a frame is. The browser side of the same
 * protocol is client/socket/websocket-events-connection.js; both sides change together.
 */
export class SocketProtocol {
    public static readonly VERSION: number = 1;

    /** The personal channel: a client names it without an id, the server maps it to the connection's own account. */
    public static readonly PERSONAL_CHANNEL: string = 'user';

    public static readonly CLOSE_REVOKED: number = 4401;
    public static readonly CLOSE_IDLE: number = 4408;
    public static readonly CLOSE_SLOW: number = 4009;
    public static readonly CLOSE_TOO_BIG: number = 1009;
    /** The instance lost its broker subscription for a channel; reconnecting subscribes afresh. */
    public static readonly CLOSE_RESYNC: number = 1012;

    /** Longest event or reply payload: one event is written whole to every subscriber at once. */
    public static readonly MAX_EVENT_LENGTH: number = 64 * 1024;

    private static readonly CHANNEL_TYPE_PATTERN: RegExp = /^[a-z]{1,32}$/;
    private static readonly CHANNEL_PATTERN: RegExp = /^([a-z]{1,32}):([A-Za-z0-9_-]{1,64})$/;
    private static readonly EVENT_TYPE_PATTERN: RegExp = /^[a-z][A-Za-z0-9.]{0,63}$/;
    private static readonly REQUEST_ID_PATTERN: RegExp = /^[A-Za-z0-9_-]{1,32}$/;
    private static readonly REFUSAL_CODE_PATTERN: RegExp = /^[a-z][a-z0-9_]{0,31}$/;

    public static readonly frames: {
        hello(userId: number | null): string;
        subscribed(channel: string): string;
        event(channel: string, type: string, data: unknown): string;
        ack(id: string, data?: unknown): string;
        pong(): string;
        error(code: string, about?: {ch?: string; id?: string | null}): string;
    } = {
        hello: (userId: number | null): string => JSON.stringify({op: 'hello', v: SocketProtocol.VERSION, user: userId}),
        subscribed: (channel: string): string => JSON.stringify({op: 'subscribed', ch: channel}),
        event: (channel: string, type: string, data: unknown): string => JSON.stringify({op: 'event', ch: channel, t: type, d: data}),
        ack: (id: string, data?: unknown): string => JSON.stringify(data === undefined ? {op: 'ack', id} : {op: 'ack', id, d: data}),
        pong: (): string => '{"op":"pong"}',
        error: (code: string, about: {ch?: string; id?: string | null} = {}): string => {
            const frame: Record<string, string> = {op: 'error', code};
            if (about.ch !== undefined) {
                frame.ch = about.ch;
            }
            if (about.id) {
                frame.id = about.id;
            }

            return JSON.stringify(frame);
        },
    };

    public static parseChannel(name: unknown): SocketChannelName | null {
        if (name === SocketProtocol.PERSONAL_CHANNEL) {
            return {type: SocketProtocol.PERSONAL_CHANNEL, key: ''};
        }
        const match: RegExpExecArray | null = typeof name === 'string' ? SocketProtocol.CHANNEL_PATTERN.exec(name) : null;

        // `user:<id>` would be a second name of the personal channel; only the bare `user` is.
        return match && match[1] !== SocketProtocol.PERSONAL_CHANNEL ? {type: match[1], key: match[2]} : null;
    }

    /** A type a channel controller may declare: the pattern of the protocol, without the personal channel. */
    public static isChannelType(type: unknown): type is string {
        return typeof type === 'string' && SocketProtocol.CHANNEL_TYPE_PATTERN.test(type) && type !== SocketProtocol.PERSONAL_CHANNEL;
    }

    public static isEventType(type: unknown): type is string {
        return typeof type === 'string' && SocketProtocol.EVENT_TYPE_PATTERN.test(type);
    }

    public static isRefusalCode(code: unknown): code is string {
        return typeof code === 'string' && SocketProtocol.REFUSAL_CODE_PATTERN.test(code);
    }

    public static parseClientFrame(text: string): SocketClientFrame | null {
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch {
            return null;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return null;
        }
        const frame: Record<string, unknown> = value as Record<string, unknown>;

        switch (frame.op) {
            case 'ping':
                return {op: 'ping'};
            case 'sub':
            case 'unsub':
                return typeof frame.ch === 'string' ? {op: frame.op, ch: frame.ch} : null;
            case 'send': {
                if (typeof frame.ch !== 'string' || typeof frame.t !== 'string') {
                    return null;
                }
                const id: string | null = typeof frame.id === 'string' && SocketProtocol.REQUEST_ID_PATTERN.test(frame.id) ? frame.id : null;

                return {op: 'send', ch: frame.ch, t: frame.t, d: frame.d ?? null, id};
            }
            default:
                return null;
        }
    }

    public static encodeBusEvent(type: string, data: unknown, except: string | null): string {
        return JSON.stringify(except === null ? {t: type, d: data ?? null} : {t: type, d: data ?? null, x: except});
    }

    public static decodeBusEvent(payload: string): SocketBusEvent | null {
        try {
            const value: unknown = JSON.parse(payload);
            if (typeof value !== 'object' || value === null) {
                return null;
            }
            const event: Record<string, unknown> = value as Record<string, unknown>;
            if (!SocketProtocol.isEventType(event.t)) {
                return null;
            }

            return {t: event.t, d: event.d ?? null, x: typeof event.x === 'string' ? event.x : null};
        } catch {
            return null;
        }
    }

    /** Broker subject of a channel. Keys never contain dots or wildcards (CHANNEL_PATTERN), so one channel = one subject. */
    public static subject(prefix: string, type: string, key: string): string {
        return `${prefix}.${type}.${key}`;
    }

    public static personalSubject(prefix: string, userId: number): string {
        return SocketProtocol.subject(prefix, SocketProtocol.PERSONAL_CHANNEL, String(userId));
    }
}
