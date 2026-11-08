import {AbstractLogger} from "../../../types/interfaces/AbstractLogger";
import {SocketBroker, SocketBrokerSubscription} from "../../../types/interfaces/SocketBroker";
import {SocketConnection} from "../../../types/interfaces/SocketConnection";
import {SocketContext} from "../../../types/interfaces/SocketContext";
import {SocketRefusalError} from "../../../errors/ApplicationError/SocketRefusalError";
import {ValidationError} from "../../../errors/ValidationError";
import {SocketBusEvent, SocketChannelName, SocketClientFrame, SocketProtocol} from "./SocketProtocol";

export interface SocketLimits {
    /** Longest client frame in characters; a longer one closes the connection. */
    maxFrameLength: number;
    maxChannels: number;
    /** Token bucket for client frames: capacity and refill per second. */
    burst: number;
    refillPerSecond: number;
    /** Above this send buffer, events of lossy channels are skipped for the connection. */
    lossyBufferBytes: number;
    /** Above this send buffer the client is too slow to keep: the connection closes and the client reconnects. */
    maxBufferBytes: number;
    /** A client pings every 25 s; silence longer than this means the connection is dead. */
    idleMs: number;
    sweepMs: number;
}

export interface SocketMessageHandler {
    requiresLogin: boolean;
    /** Roles from `@RequiresAuth(roles)`; null when the method has none. */
    roles: string[] | null;
    handle(context: SocketContext, data: unknown): unknown;
}

export interface SocketChannelHandlers {
    lossy: boolean;
    join(context: SocketContext): boolean | Promise<boolean>;
    leave(context: SocketContext): void | Promise<void>;
    messages: ReadonlyMap<string, SocketMessageHandler>;
}

export interface SocketPeer {
    send(frame: string): void;
    close(code: number, reason: string): void;
    /** Bytes queued for sending and not yet written to the network - the hub's measure of a slow client. */
    readonly bufferedAmount: number;
}

export interface SocketHubOptions {
    broker: SocketBroker;
    subjectPrefix: string;
    log: AbstractLogger;
    limits?: Partial<SocketLimits>;
    now?: () => number;
    /** The endpoint's `disconnect`, called once per connection after `leave` of all its channels. */
    disconnect?: (connection: SocketConnection) => void | Promise<void>;
}

export interface SocketHubConnection {
    receive(text: string): void;
    closed(): void;
}

/** Session check repeated on every sweep; false closes the connection with 4401 (logout, revoked token). */
export type SocketSessionCheck = () => boolean;

interface Subscription {
    readonly name: string;
    readonly subject: string;
    /** Null on the personal channel, which has no controller. */
    readonly handlers: SocketChannelHandlers | null;
    readonly context: SocketContext | null;
    queue: Promise<void>;
}

interface Member {
    readonly socket: SocketPeer;
    readonly connection: SocketConnection;
    readonly role: string | null;
    readonly stillValid: SocketSessionCheck | null;
    readonly subscriptions: Map<string, Subscription>;
    readonly pending: Set<string>;
    readonly cancelled: Set<string>;
    /** Subscriptions still in `join`; `disconnect` waits for them, so it comes after their `leave`. */
    readonly joins: Set<Promise<void>>;
    lastSeen: number;
    tokens: number;
    tokensAt: number;
    closed: boolean;
}

interface Channel {
    readonly name: string;
    readonly lossy: boolean;
    readonly members: Set<Member>;
    readonly subscription: SocketBrokerSubscription;
}

type JoinOutcome = {allowed: true; context: SocketContext} | {allowed: false; code: string};

/**
 * The server side of the channel protocol for one endpoint: connections, channel subscriptions, the order of messages
 * and fan-out. A broker subject is subscribed only while at least one local connection is in its channel, and each
 * broker message is encoded once for all of them.
 */
export class SocketHub {
    public static readonly DEFAULT_LIMITS: SocketLimits = {
        maxFrameLength: 16 * 1024,
        maxChannels: 32,
        // Above maxChannels, so a page subscribing to everything it may at once is never throttled.
        burst: 40,
        refillPerSecond: 10,
        lossyBufferBytes: 256 * 1024,
        maxBufferBytes: 1024 * 1024,
        idleMs: 75_000,
        sweepMs: 30_000,
    };

    public readonly limits: SocketLimits;

    private readonly broker: SocketBroker;
    private readonly subjectPrefix: string;
    private readonly log: AbstractLogger;
    private readonly now: () => number;
    private readonly disconnect: ((connection: SocketConnection) => void | Promise<void>) | null;
    private readonly types: Map<string, SocketChannelHandlers> = new Map<string, SocketChannelHandlers>();
    private readonly members: Set<Member> = new Set<Member>();
    private readonly channels: Map<string, Channel> = new Map<string, Channel>();
    private sweeper: NodeJS.Timeout | null = null;
    private stopped: boolean = false;

    public constructor(options: SocketHubOptions) {
        this.broker = options.broker;
        this.subjectPrefix = options.subjectPrefix;
        this.log = options.log;
        this.limits = {...SocketHub.DEFAULT_LIMITS, ...options.limits};
        this.now = options.now ?? Date.now;
        this.disconnect = options.disconnect ?? null;
    }

    public register(type: string, handlers: SocketChannelHandlers): void {
        if (!SocketProtocol.isChannelType(type)) {
            throw new Error(`Invalid socket channel type "${type}"`);
        }
        if (this.types.has(type)) {
            throw new Error(`Socket channel type "${type}" is already registered`);
        }
        this.types.set(type, handlers);
    }

    public attach(socket: SocketPeer, connection: SocketConnection, role: string | null, stillValid: SocketSessionCheck | null = null): SocketHubConnection {
        const now: number = this.now();
        const member: Member = {
            socket,
            connection,
            role,
            stillValid,
            subscriptions: new Map<string, Subscription>(),
            pending: new Set<string>(),
            cancelled: new Set<string>(),
            joins: new Set<Promise<void>>(),
            lastSeen: now,
            tokens: this.limits.burst,
            tokensAt: now,
            closed: false,
        };
        this.members.add(member);
        this.write(member, SocketProtocol.frames.hello(connection.userId), false);

        return {
            receive: (frame: string): void => this.receive(member, frame),
            closed: (): void => this.drop(member),
        };
    }

    public start(): void {
        if (this.sweeper === null) {
            this.sweeper = setInterval((): void => this.sweep(), this.limits.sweepMs);
            this.sweeper.unref();
        }
    }

    /** Stops the sweep and leaves every broker subject; the web server closes the sockets themselves. */
    public stop(): void {
        this.stopped = true;
        if (this.sweeper !== null) {
            clearInterval(this.sweeper);
            this.sweeper = null;
        }
        for (const channel of this.channels.values()) {
            channel.subscription.unsubscribe();
        }
        this.channels.clear();
    }

    /** Closes connections that went silent or whose session is no longer valid. Public for tests. */
    public sweep(): void {
        const now: number = this.now();
        for (const member of [...this.members]) {
            if (now - member.lastSeen > this.limits.idleMs) {
                this.close(member, SocketProtocol.CLOSE_IDLE, 'Idle');
            } else if (member.stillValid !== null && !member.stillValid()) {
                this.close(member, SocketProtocol.CLOSE_REVOKED, 'Session revoked');
            }
        }
    }

    public stats(): {connections: number; channels: number} {
        return {connections: this.members.size, channels: this.channels.size};
    }

    private receive(member: Member, text: string): void {
        if (member.closed) {
            return;
        }
        member.lastSeen = this.now();
        if (text.length > this.limits.maxFrameLength) {
            this.close(member, SocketProtocol.CLOSE_TOO_BIG, 'Frame too large');
            return;
        }
        const frame: SocketClientFrame | null = SocketProtocol.parseClientFrame(text);
        if (!this.takeToken(member)) {
            // The channel goes back with the refusal, so the client can ask again later instead of giving it up.
            this.write(member, SocketProtocol.frames.error('rate_limited', SocketHub.about(frame)), false);
            return;
        }
        if (frame === null) {
            this.write(member, SocketProtocol.frames.error('bad_frame'), false);
            return;
        }
        switch (frame.op) {
            case 'ping':
                this.write(member, SocketProtocol.frames.pong(), false);
                return;
            case 'sub': {
                const joining: Promise<void> = this.subscribe(member, frame.ch).catch((error: unknown): void => {
                    this.log.error(`Subscribing to "${frame.ch}" failed:`, error);
                });
                member.joins.add(joining);
                void joining.then((): boolean => member.joins.delete(joining));
                return;
            }
            case 'unsub':
                this.unsubscribe(member, frame.ch);
                return;
            case 'send':
                this.send(member, frame.ch, frame.t, frame.d, frame.id);
                return;
        }
    }

    private async subscribe(member: Member, name: string): Promise<void> {
        if (this.stopped) {
            return;
        }
        const channel: SocketChannelName | null = SocketProtocol.parseChannel(name);
        if (channel === null) {
            this.write(member, SocketProtocol.frames.error('bad_channel', {ch: name}), false);
            return;
        }
        if (member.subscriptions.has(name)) {
            this.write(member, SocketProtocol.frames.subscribed(name), false);
            return;
        }
        if (member.pending.has(name)) {
            member.cancelled.delete(name);
            return;
        }
        if (member.subscriptions.size + member.pending.size >= this.limits.maxChannels) {
            this.write(member, SocketProtocol.frames.error('too_many_channels', {ch: name}), false);
            return;
        }

        if (channel.type === SocketProtocol.PERSONAL_CHANNEL) {
            if (member.connection.userId === null) {
                this.write(member, SocketProtocol.frames.error('forbidden', {ch: name}), false);
                return;
            }
            const joined: boolean = this.join(member, {
                name,
                subject: SocketProtocol.personalSubject(this.subjectPrefix, member.connection.userId),
                handlers: null,
                context: null,
                queue: Promise.resolve(),
            }, false);
            if (joined) {
                this.write(member, SocketProtocol.frames.subscribed(name), false);
            }
            return;
        }

        const handlers: SocketChannelHandlers | undefined = this.types.get(channel.type);
        if (handlers === undefined) {
            this.write(member, SocketProtocol.frames.error('unknown_channel', {ch: name}), false);
            return;
        }

        member.pending.add(name);
        const outcome: JoinOutcome = await this.askToJoin(handlers, member.connection, name, channel.key);
        member.pending.delete(name);
        if (member.closed || member.cancelled.delete(name) || this.stopped) {
            if (outcome.allowed) {
                await this.runLeave(handlers, outcome.context);
            }
            return;
        }
        if (!outcome.allowed) {
            this.write(member, SocketProtocol.frames.error(outcome.code, {ch: name}), false);
            return;
        }
        const joined: boolean = this.join(member, {
            name,
            subject: SocketProtocol.subject(this.subjectPrefix, channel.type, channel.key),
            handlers,
            context: outcome.context,
            queue: Promise.resolve(),
        }, handlers.lossy);
        if (!joined) {
            await this.runLeave(handlers, outcome.context);
            return;
        }
        this.write(member, SocketProtocol.frames.subscribed(name), false);
    }

    /** `join` of the controller: false and unexpected errors are `forbidden`, a refusal carries its own code. */
    private async askToJoin(handlers: SocketChannelHandlers, connection: SocketConnection, name: string, key: string): Promise<JoinOutcome> {
        const context: SocketContext = {connection, channel: name, key, state: {}};
        try {
            return await handlers.join(context) === true ? {allowed: true, context} : {allowed: false, code: 'forbidden'};
        } catch (error) {
            if (error instanceof SocketRefusalError) {
                this.log.debug(`Joining channel "${name}" refused (${error.code}): ${error.message}`);
                return {allowed: false, code: error.code};
            }
            this.log.error(`Joining channel "${name}" failed:`, error);

            return {allowed: false, code: 'forbidden'};
        }
    }

    private unsubscribe(member: Member, name: string): void {
        if (member.pending.has(name)) {
            member.cancelled.add(name);
        }
        void this.leave(member, name);
    }

    private send(member: Member, name: string, type: string, data: unknown, id: string | null): void {
        const about: {ch: string; id: string | null} = {ch: name, id};
        const subscription: Subscription | undefined = member.subscriptions.get(name);
        if (subscription === undefined) {
            this.write(member, SocketProtocol.frames.error('not_subscribed', about), false);
            return;
        }
        if (!SocketProtocol.isEventType(type)) {
            this.write(member, SocketProtocol.frames.error('bad_frame', about), false);
            return;
        }
        const handler: SocketMessageHandler | undefined = subscription.handlers?.messages.get(type);
        if (handler === undefined || subscription.context === null) {
            this.write(member, SocketProtocol.frames.error('unsupported', about), false);
            return;
        }
        const context: SocketContext = subscription.context;

        // One message of a connection in a channel at a time, so messages from one tab keep their order.
        subscription.queue = subscription.queue
            .then((): Promise<void> => this.dispatch(member, subscription, context, handler, data, about))
            .catch((error: unknown): void => {
                this.log.error(`Message on channel "${name}" failed:`, error);
            });
    }

    private async dispatch(
        member: Member,
        subscription: Subscription,
        context: SocketContext,
        handler: SocketMessageHandler,
        data: unknown,
        about: {ch: string; id: string | null},
    ): Promise<void> {
        if (member.closed) {
            return;
        }
        if (member.subscriptions.get(subscription.name) !== subscription) {
            this.write(member, SocketProtocol.frames.error('not_subscribed', about), false);
            return;
        }
        if (!this.mayCall(member, handler)) {
            this.write(member, SocketProtocol.frames.error('forbidden', about), false);
            return;
        }

        let result: unknown;
        try {
            result = await handler.handle(context, data);
        } catch (error) {
            this.write(member, SocketProtocol.frames.error(this.refusalCode(error, about.ch), about), false);
            return;
        }
        if (about.id === null) {
            return;
        }

        let frame: string;
        try {
            frame = SocketProtocol.frames.ack(about.id, result);
        } catch (error) {
            this.log.error(`Reply on channel "${about.ch}" cannot be serialized:`, error);
            this.write(member, SocketProtocol.frames.error('failed', about), false);
            return;
        }
        if (frame.length > SocketProtocol.MAX_EVENT_LENGTH) {
            this.log.error(`Reply on channel "${about.ch}" is ${frame.length} characters, over ${SocketProtocol.MAX_EVENT_LENGTH}`);
            this.write(member, SocketProtocol.frames.error('failed', about), false);
            return;
        }
        this.write(member, frame, false);
    }

    /** Same rule as `@RequiresAuth` over HTTP: with roles the one role of the token must be each of them, without roles any account. */
    private mayCall(member: Member, handler: SocketMessageHandler): boolean {
        if (handler.roles !== null) {
            return member.role !== null && handler.roles.every((role: string): boolean => role === member.role);
        }

        return !handler.requiresLogin || member.connection.userId !== null;
    }

    /** Only a typed refusal reaches the client as itself; anything unexpected is `failed`, and its text stays in the log. */
    private refusalCode(error: unknown, channel: string): string {
        if (error instanceof SocketRefusalError) {
            this.log.debug(`Message on channel "${channel}" refused (${error.code}): ${error.message}`);
            return error.code;
        }
        if (error instanceof ValidationError) {
            return 'invalid';
        }
        this.log.error(`Message on channel "${channel}" failed:`, error);

        return 'failed';
    }

    /** False when the broker refused the subscription (e.g. its connection is closed); the client gets `failed`. */
    private join(member: Member, subscription: Subscription, lossy: boolean): boolean {
        let channel: Channel | undefined = this.channels.get(subscription.subject);
        if (channel === undefined) {
            const subject: string = subscription.subject;
            let brokerSubscription: SocketBrokerSubscription;
            try {
                brokerSubscription = this.broker.subscribe(
                    subject,
                    (payload: string): void => this.deliver(subject, payload),
                    (error: Error): void => this.lost(subject, error),
                );
            } catch (error) {
                this.log.error(`Socket subscription to "${subject}" failed:`, error);
                this.write(member, SocketProtocol.frames.error('failed', {ch: subscription.name}), false);
                return false;
            }
            channel = {name: subscription.name, lossy, members: new Set<Member>(), subscription: brokerSubscription};
            this.channels.set(subject, channel);
        }
        channel.members.add(member);
        member.subscriptions.set(subscription.name, subscription);

        return true;
    }

    private leave(member: Member, name: string): Promise<void> {
        const subscription: Subscription | undefined = member.subscriptions.get(name);
        if (subscription === undefined) {
            return Promise.resolve();
        }
        member.subscriptions.delete(name);

        const channel: Channel | undefined = this.channels.get(subscription.subject);
        if (channel !== undefined) {
            channel.members.delete(member);
            if (channel.members.size === 0) {
                channel.subscription.unsubscribe();
                this.channels.delete(subscription.subject);
            }
        }

        if (subscription.handlers === null || subscription.context === null) {
            return Promise.resolve();
        }
        const handlers: SocketChannelHandlers = subscription.handlers;
        const context: SocketContext = subscription.context;

        // After the message in progress, so `leave` never runs alongside a method of the same subscription.
        return subscription.queue.then((): Promise<void> => this.runLeave(handlers, context));
    }

    private async runLeave(handlers: SocketChannelHandlers, context: SocketContext): Promise<void> {
        try {
            await handlers.leave(context);
        } catch (error) {
            this.log.error(`Leaving channel "${context.channel}" failed:`, error);
        }
    }

    /** The broker dropped a subscription: members reconnect (to any instance) and so subscribe afresh. */
    private lost(subject: string, error: Error): void {
        const channel: Channel | undefined = this.channels.get(subject);
        this.log.error(`Socket subscription to "${subject}" failed:`, error);
        if (channel === undefined) {
            return;
        }
        this.channels.delete(subject);
        for (const member of [...channel.members]) {
            this.close(member, SocketProtocol.CLOSE_RESYNC, 'Resubscribe');
        }
    }

    private deliver(subject: string, payload: string): void {
        const channel: Channel | undefined = this.channels.get(subject);
        if (channel === undefined) {
            return;
        }
        const event: SocketBusEvent | null = SocketProtocol.decodeBusEvent(payload);
        if (event === null) {
            this.log.warning(`Malformed socket event on "${subject}" dropped`);
            return;
        }

        const frame: string = SocketProtocol.frames.event(channel.name, event.t, event.d);
        for (const member of [...channel.members]) {
            if (member.connection.id !== event.x) {
                this.write(member, frame, channel.lossy);
            }
        }
    }

    private write(member: Member, frame: string, lossy: boolean): void {
        if (member.closed) {
            return;
        }
        const buffered: number = member.socket.bufferedAmount;
        if (buffered > this.limits.maxBufferBytes) {
            this.close(member, SocketProtocol.CLOSE_SLOW, 'Slow consumer');
            return;
        }
        if (lossy && buffered > this.limits.lossyBufferBytes) {
            return;
        }
        try {
            member.socket.send(frame);
        } catch (error) {
            this.log.debug('Write to a closing socket failed:', error);
            this.drop(member);
        }
    }

    private static about(frame: SocketClientFrame | null): {ch?: string; id?: string | null} {
        if (frame === null || frame.op === 'ping') {
            return {};
        }

        return frame.op === 'send' ? {ch: frame.ch, id: frame.id} : {ch: frame.ch};
    }

    private takeToken(member: Member): boolean {
        const now: number = this.now();
        member.tokens = Math.min(
            this.limits.burst,
            member.tokens + (now - member.tokensAt) / 1000 * this.limits.refillPerSecond,
        );
        member.tokensAt = now;
        if (member.tokens < 1) {
            return false;
        }
        member.tokens -= 1;

        return true;
    }

    private close(member: Member, code: number, reason: string): void {
        if (member.closed) {
            return;
        }
        this.drop(member);
        try {
            member.socket.close(code, reason);
        } catch (error) {
            this.log.debug('Socket close failed:', error);
        }
    }

    private drop(member: Member): void {
        if (member.closed) {
            return;
        }
        member.closed = true;
        this.members.delete(member);
        const leaving: Promise<void>[] = [...member.subscriptions.keys()].map((name: string): Promise<void> => this.leave(member, name));
        if (this.disconnect === null) {
            return;
        }
        const disconnect: (connection: SocketConnection) => void | Promise<void> = this.disconnect;
        void Promise.all([...leaving, ...member.joins])
            .then((): void | Promise<void> => disconnect(member.connection))
            .catch((error: unknown): void => {
                this.log.error(`Disconnecting socket ${member.connection.id} failed:`, error);
            });
    }
}
