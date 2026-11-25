import {randomUUID} from "node:crypto";
import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {SocketBrokerSubscription} from "../../types/interfaces/SocketBroker";
import {SocketPresenceChange} from "../../types/interfaces/SocketPresenceChange";
import {SocketChannelName, SocketProtocol} from "../../infrastructure/Server/socket/SocketProtocol";
import {SocketPublisher} from "./SocketPublisher";

export interface SocketPresenceOptions {
    graceMs?: number;
    heartbeatMs?: number;
    expireMs?: number;
    syncWaitMs?: number;
    now?: () => number;
    instanceId?: string;
}

export type SocketPresenceHandler = (channel: string, change: SocketPresenceChange) => void | Promise<void>;

type SocketPresenceTiming = Required<Omit<SocketPresenceOptions, 'now' | 'instanceId'>>;

type SocketPresenceMessage =
    | {kind: 'alive' | 'sync' | 'bye'; instanceId: string}
    | {kind: 'state' | 'joined' | 'left'; instanceId: string; channel: string; accounts: number[]};

interface RemoteChannel {
    accounts: Set<number>;
    expiry: NodeJS.Timeout;
}

interface RemoteInstance {
    seenAt: number;
    heartbeatAt: number | null;
    expiry: NodeJS.Timeout;
    channels: Map<string, RemoteChannel>;
}

export class SocketPresence {
    public static readonly DEFAULTS: SocketPresenceTiming = Object.freeze({graceMs: 5000, heartbeatMs: 10000, expireMs: 30000, syncWaitMs: 1000});

    public readonly instanceId: string;

    private static readonly VERSION: number = 1;

    private readonly subject: string;
    private readonly timing: SocketPresenceTiming;
    private readonly now: () => number;
    private readonly handlers: Map<string, SocketPresenceHandler> = new Map<string, SocketPresenceHandler>();
    private readonly localCounts: Map<string, Map<number, number>> = new Map<string, Map<number, number>>();
    private readonly graces: Map<string, Map<number, NodeJS.Timeout>> = new Map<string, Map<number, NodeJS.Timeout>>();
    private readonly pendingJoins: Map<string, Set<number>> = new Map<string, Set<number>>();
    private readonly remotes: Map<string, RemoteInstance> = new Map<string, RemoteInstance>();
    private readonly holding: Set<Map<string, Set<number>>> = new Set<Map<string, Set<number>>>();
    private readonly timers: Set<NodeJS.Timeout> = new Set<NodeJS.Timeout>();
    private readonly syncWaiters: Array<() => void> = [];
    private log: AbstractLogger | null = null;
    private subscription: SocketBrokerSubscription | null = null;
    private heartbeat: NodeJS.Timeout | null = null;
    private running: boolean = false;
    private synced: boolean = false;

    public constructor(private readonly publisher: SocketPublisher, options: SocketPresenceOptions = {}) {
        this.instanceId = options.instanceId ?? randomUUID();
        this.now = options.now ?? Date.now;
        this.timing = {
            graceMs: options.graceMs ?? SocketPresence.DEFAULTS.graceMs,
            heartbeatMs: options.heartbeatMs ?? SocketPresence.DEFAULTS.heartbeatMs,
            expireMs: options.expireMs ?? SocketPresence.DEFAULTS.expireMs,
            syncWaitMs: options.syncWaitMs ?? SocketPresence.DEFAULTS.syncWaitMs,
        };
        this.subject = `${publisher.subjectPrefix}.presence`;
    }

    public register(type: string, handler: SocketPresenceHandler): void {
        if (!SocketProtocol.isChannelType(type)) {
            throw new Error(`Invalid presence channel type "${type}"`);
        }
        if (this.handlers.has(type)) {
            throw new Error(`Presence channel type "${type}" already has a handler`);
        }
        this.handlers.set(type, handler);
    }

    public start(log: AbstractLogger): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.synced = false;
        this.log = log;
        this.subscribe();
        this.heartbeat = setInterval((): void => this.beat(), this.timing.heartbeatMs);
        this.heartbeat.unref();
        this.schedule(this.timing.syncWaitMs, (): void => this.finishSync());
    }

    public stop(): void {
        if (!this.running) {
            return;
        }
        this.releaseSyncWaiters();
        this.publish({k: 'bye'});
        this.running = false;
        this.synced = false;
        this.subscription?.unsubscribe();
        this.subscription = null;
        if (this.heartbeat !== null) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.localCounts.clear();
        this.graces.clear();
        this.pendingJoins.clear();
        this.remotes.clear();
        this.holding.clear();
    }

    public enter(channel: string, userId: number): void {
        this.requireTracked(channel);
        if (!this.running) {
            return;
        }
        const counts: Map<number, number> = this.localCounts.get(channel) ?? new Map<number, number>();
        const count: number = counts.get(userId) ?? 0;
        counts.set(userId, count + 1);
        this.localCounts.set(channel, counts);
        if (count > 0) {
            return;
        }
        const grace: NodeJS.Timeout | undefined = this.graces.get(channel)?.get(userId);
        if (grace !== undefined) {
            this.cancel(grace);
            this.removeGrace(channel, userId);
            return;
        }
        if (!this.synced) {
            const pending: Set<number> = this.pendingJoins.get(channel) ?? new Set<number>();
            pending.add(userId);
            this.pendingJoins.set(channel, pending);
            return;
        }
        this.decideJoins(channel, [userId]);
    }

    public exit(channel: string, userId: number): void {
        this.requireTracked(channel);
        if (!this.running) {
            return;
        }
        const counts: Map<number, number> | undefined = this.localCounts.get(channel);
        const count: number = counts?.get(userId) ?? 0;
        if (counts === undefined || count === 0) {
            return;
        }
        if (count > 1) {
            counts.set(userId, count - 1);
            return;
        }
        counts.delete(userId);
        if (counts.size === 0) {
            this.localCounts.delete(channel);
        }
        const pending: Set<number> | undefined = this.pendingJoins.get(channel);
        if (pending?.delete(userId)) {
            if (pending.size === 0) {
                this.pendingJoins.delete(channel);
            }
            return;
        }
        const graces: Map<number, NodeJS.Timeout> = this.graces.get(channel) ?? new Map<number, NodeJS.Timeout>();
        graces.set(userId, this.schedule(this.timing.graceMs, (): void => this.finishGrace(channel, userId)));
        this.graces.set(channel, graces);
    }

    public members(channel: string): Promise<number[]> {
        this.requireTracked(channel);
        if (this.synced) {
            return Promise.resolve(this.list(channel));
        }

        return new Promise<number[]>((resolve: (members: number[]) => void): void => {
            this.syncWaiters.push((): void => resolve(this.list(channel)));
        });
    }

    private subscribe(): void {
        try {
            this.subscription = this.publisher.broker.subscribe(
                this.subject,
                (payload: string): void => this.receive(payload),
                (error: Error): void => this.subscriptionFailed(error),
            );
        } catch (error) {
            this.subscriptionFailed(error);
            return;
        }
        this.publish({k: 'sync'});
    }

    private subscriptionFailed(error: unknown): void {
        this.subscription = null;
        this.log?.error('Presence subscription failed:', error);
    }

    private beat(): void {
        if (this.subscription === null) {
            this.subscribe();
        }
        this.announce();
    }

    private announce(): void {
        this.publish({k: 'alive'});
        for (const channel of new Set<string>([...this.localCounts.keys(), ...this.graces.keys()])) {
            this.publish({k: 'state', ch: channel, u: this.localAccounts(channel)});
        }
    }

    private finishSync(): void {
        this.synced = true;
        const pendingJoins: [string, Set<number>][] = [...this.pendingJoins];
        this.pendingJoins.clear();
        for (const [channel, accounts] of pendingJoins) {
            this.decideJoins(channel, SocketPresence.sorted(accounts));
        }
        this.releaseSyncWaiters();
    }

    private releaseSyncWaiters(): void {
        for (const release of this.syncWaiters.splice(0)) {
            release();
        }
    }

    private decideJoins(channel: string, accounts: number[]): void {
        this.publish({k: 'joined', ch: channel, u: accounts});
        const joined: number[] = accounts.filter((userId: number): boolean => !this.isRemote(channel, userId) && !this.isHeld(channel, userId, null));
        if (joined.length > 0) {
            this.changed(channel, {joined, left: []});
        }
    }

    private finishGrace(channel: string, userId: number): void {
        this.removeGrace(channel, userId);
        this.publish({k: 'left', ch: channel, u: [userId]});
        if (!this.isRemote(channel, userId) && !this.isHeld(channel, userId, null)) {
            this.changed(channel, {joined: [], left: [userId]});
        }
    }

    private removeGrace(channel: string, userId: number): void {
        const graces: Map<number, NodeJS.Timeout> | undefined = this.graces.get(channel);
        graces?.delete(userId);
        if (graces?.size === 0) {
            this.graces.delete(channel);
        }
    }

    private receive(payload: string): void {
        const message: SocketPresenceMessage | null = SocketPresence.decode(payload);
        if (message === null || message.instanceId === this.instanceId || !this.running) {
            return;
        }
        if (message.kind === 'bye') {
            this.depart(message.instanceId, this.timing.graceMs);
            return;
        }
        const remote: RemoteInstance = this.heard(message.instanceId);
        switch (message.kind) {
            case 'alive':
                remote.heartbeatAt = this.now();
                break;
            case 'sync':
                this.announce();
                break;
            case 'state':
            case 'joined':
            case 'left':
                this.updateRemote(remote, message.instanceId, message.kind, message.channel, message.accounts);
                break;
            default:
                break;
        }
    }

    private heard(instanceId: string): RemoteInstance {
        const expiry: NodeJS.Timeout = this.schedule(this.timing.expireMs, (): void => this.depart(instanceId, 0));
        const remote: RemoteInstance | undefined = this.remotes.get(instanceId);
        if (remote === undefined) {
            const created: RemoteInstance = {seenAt: this.now(), heartbeatAt: null, expiry, channels: new Map<string, RemoteChannel>()};
            this.remotes.set(instanceId, created);

            return created;
        }
        this.cancel(remote.expiry);
        remote.expiry = expiry;
        remote.seenAt = this.now();

        return remote;
    }

    private updateRemote(remote: RemoteInstance, instanceId: string, kind: 'state' | 'joined' | 'left', channel: string, accounts: number[]): void {
        const entry: RemoteChannel | undefined = remote.channels.get(channel);
        if (kind === 'left') {
            for (const userId of accounts) {
                entry?.accounts.delete(userId);
            }
            if (entry !== undefined && entry.accounts.size === 0) {
                this.dropRemoteChannel(remote, channel);
            }
            return;
        }
        if (kind === 'state' && accounts.length === 0) {
            this.dropRemoteChannel(remote, channel);
            return;
        }
        const expiry: NodeJS.Timeout = this.schedule(this.timing.expireMs, (): void => this.remoteChannelStale(instanceId, channel));
        if (entry === undefined) {
            remote.channels.set(channel, {accounts: new Set<number>(accounts), expiry});
            return;
        }
        this.cancel(entry.expiry);
        entry.expiry = expiry;
        if (kind === 'state') {
            entry.accounts = new Set<number>(accounts);
        } else {
            for (const userId of accounts) {
                entry.accounts.add(userId);
            }
        }
    }

    private dropRemoteChannel(remote: RemoteInstance, channel: string): void {
        const entry: RemoteChannel | undefined = remote.channels.get(channel);
        if (entry !== undefined) {
            this.cancel(entry.expiry);
            remote.channels.delete(channel);
        }
    }

    private remoteChannelStale(instanceId: string, channel: string): void {
        const remote: RemoteInstance | undefined = this.remotes.get(instanceId);
        if (remote === undefined) {
            return;
        }
        if (this.now() - remote.seenAt >= this.timing.expireMs) {
            this.depart(instanceId, 0);
            return;
        }
        const entry: RemoteChannel | undefined = remote.channels.get(channel);
        if (entry !== undefined && (remote.heartbeatAt === null || this.now() - remote.heartbeatAt > this.timing.heartbeatMs)) {
            entry.expiry = this.schedule(this.timing.heartbeatMs, (): void => this.remoteChannelStale(instanceId, channel));
            return;
        }
        this.dropRemoteChannel(remote, channel);
    }

    private depart(instanceId: string, holdMs: number): void {
        const remote: RemoteInstance | undefined = this.remotes.get(instanceId);
        if (remote === undefined) {
            return;
        }
        this.remotes.delete(instanceId);
        this.cancel(remote.expiry);
        const held: Map<string, Set<number>> = new Map<string, Set<number>>();
        for (const [channel, entry] of remote.channels) {
            this.cancel(entry.expiry);
            held.set(channel, entry.accounts);
        }
        if (held.size === 0) {
            return;
        }
        this.holding.add(held);
        if (holdMs === 0) {
            this.releaseHeld(held);
        } else {
            this.schedule(holdMs, (): void => this.releaseHeld(held));
        }
    }

    private releaseHeld(held: Map<string, Set<number>>): void {
        this.holding.delete(held);
        if (this.lowestLiveInstance() !== this.instanceId) {
            return;
        }
        for (const [channel, accounts] of held) {
            const left: number[] = SocketPresence.sorted(accounts).filter((userId: number): boolean =>
                !this.isLocal(channel, userId) && !this.isRemote(channel, userId) && !this.isHeld(channel, userId, held));
            if (left.length > 0) {
                this.changed(channel, {joined: [], left});
            }
        }
    }

    private lowestLiveInstance(): string {
        const now: number = this.now();
        let lowest: string = this.instanceId;
        for (const [instanceId, remote] of this.remotes) {
            if (now - remote.seenAt < this.timing.expireMs && instanceId < lowest) {
                lowest = instanceId;
            }
        }

        return lowest;
    }

    private changed(channel: string, change: SocketPresenceChange): void {
        const handler: SocketPresenceHandler | undefined = this.handlers.get(SocketPresence.channelType(channel));
        if (handler === undefined) {
            return;
        }
        try {
            const result: void | Promise<void> = handler(channel, change);
            if (result instanceof Promise) {
                result.catch((error: unknown): void => this.handlerFailed(channel, error));
            }
        } catch (error) {
            this.handlerFailed(channel, error);
        }
    }

    private handlerFailed(channel: string, error: unknown): void {
        this.log?.error(`Presence change on "${channel}" failed:`, error);
    }

    private isLocal(channel: string, userId: number): boolean {
        return (this.localCounts.get(channel)?.has(userId) ?? false) || (this.graces.get(channel)?.has(userId) ?? false);
    }

    private isRemote(channel: string, userId: number): boolean {
        for (const remote of this.remotes.values()) {
            if (remote.channels.get(channel)?.accounts.has(userId)) {
                return true;
            }
        }

        return false;
    }

    private isHeld(channel: string, userId: number, except: Map<string, Set<number>> | null): boolean {
        for (const held of this.holding) {
            if (held !== except && held.get(channel)?.has(userId)) {
                return true;
            }
        }

        return false;
    }

    private localAccounts(channel: string): number[] {
        return SocketPresence.sorted(new Set<number>([...(this.localCounts.get(channel)?.keys() ?? []), ...(this.graces.get(channel)?.keys() ?? [])]));
    }

    private list(channel: string): number[] {
        const accounts: Set<number> = new Set<number>(this.localAccounts(channel));
        for (const remote of this.remotes.values()) {
            for (const userId of remote.channels.get(channel)?.accounts ?? []) {
                accounts.add(userId);
            }
        }
        for (const held of this.holding) {
            for (const userId of held.get(channel) ?? []) {
                accounts.add(userId);
            }
        }

        return SocketPresence.sorted(accounts);
    }

    private requireTracked(channel: string): void {
        const name: SocketChannelName | null = SocketProtocol.parseChannel(channel);
        if (name === null || name.type === SocketProtocol.PERSONAL_CHANNEL) {
            throw new Error(`Invalid presence channel "${channel}"`);
        }
        if (!this.handlers.has(name.type)) {
            throw new Error(`Channel type "${name.type}" has no presence handler`);
        }
    }

    private publish(message: {k: string; ch?: string; u?: number[]}): void {
        try {
            this.publisher.broker.publish(this.subject, JSON.stringify({v: SocketPresence.VERSION, i: this.instanceId, ...message}));
        } catch (error) {
            this.log?.error(`Presence message "${message.k}" failed:`, error);
        }
    }

    private schedule(milliseconds: number, callback: () => void): NodeJS.Timeout {
        const timer: NodeJS.Timeout = setTimeout((): void => {
            this.timers.delete(timer);
            callback();
        }, milliseconds);
        timer.unref();
        this.timers.add(timer);

        return timer;
    }

    private cancel(timer: NodeJS.Timeout): void {
        clearTimeout(timer);
        this.timers.delete(timer);
    }

    private static channelType(channel: string): string {
        return SocketProtocol.parseChannel(channel)?.type ?? '';
    }

    private static sorted(accounts: Iterable<number>): number[] {
        return [...accounts].sort((first: number, second: number): number => first - second);
    }

    private static decode(payload: string): SocketPresenceMessage | null {
        let value: unknown;
        try {
            value = JSON.parse(payload);
        } catch {
            return null;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return null;
        }
        const message: Record<string, unknown> = value as Record<string, unknown>;
        if (message.v !== SocketPresence.VERSION || typeof message.i !== 'string' || message.i === '') {
            return null;
        }
        switch (message.k) {
            case 'alive':
            case 'sync':
            case 'bye':
                return {kind: message.k, instanceId: message.i};
            case 'state':
            case 'joined':
            case 'left': {
                const name: SocketChannelName | null = SocketProtocol.parseChannel(message.ch);
                if (name === null || name.type === SocketProtocol.PERSONAL_CHANNEL || !SocketPresence.isAccountList(message.u)) {
                    return null;
                }

                return {kind: message.k, instanceId: message.i, channel: message.ch as string, accounts: message.u};
            }
            default:
                return null;
        }
    }

    private static isAccountList(value: unknown): value is number[] {
        return Array.isArray(value) && value.every((userId: unknown): boolean => Number.isInteger(userId) && (userId as number) > 0);
    }
}
