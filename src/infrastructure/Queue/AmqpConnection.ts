import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {AmqpChannel, AmqpChannelModel, AmqpConfirmChannel, AmqpPublishOptions} from "./AmqpTypes";

export interface AmqpConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    vhost?: string;
    /** AMQP heartbeat in seconds. 0 disables. */
    heartbeat?: number;
    /** Delay between reconnect attempts in milliseconds. */
    reconnectDelay?: number;
}

/**
 * Signature of the callback invoked after a successful reconnect. The
 * QueueService registers one so it can re-declare queues and re-register
 * consumers on the fresh connection (channels do not survive a reconnect).
 */
export type OnReconnectCallback = () => Promise<void> | void;

type RequireResult = {
    connect(url: string | object, socketOptions?: unknown): Promise<AmqpChannelModel>;
};

/**
 * Connector managing a single AMQP 0-9-1 connection and its channels.
 *
 * Design principles enforced by the API:
 *  1. One shared confirm channel for publishing (lazy, cached) - separate
 *     from consumer channels so a broker-side channel error on publish never
 *     disrupts consumption.
 *  2. A new channel per consumer (prefetch is per-channel, not per-consumer;
 *     a shared channel would make consumers steal each other's prefetch budget).
 *  3. Automatic reconnect with re-setup hook: after the connection is restored
 *     the cached publish channel is invalidated and the onReconnect callback
 *     fires so the QueueService can re-create consumer channels and re-consume.
 *
 * The amqplib dependency is loaded lazily via require() inside connect(), so
 * projects that don't use AMQP don't need amqplib installed at runtime or
 * @types/amqplib at compile time.
 */
export class AmqpConnection {
    private static readonly LoggerTag: string = 'AmqpConnection';

    private connection: AmqpChannelModel | null = null;
    private publishChannel: AmqpConfirmChannel | null = null;
    private connected: boolean = false;
    private connecting: boolean = false;
    private reconnecting: boolean = false;
    private closed: boolean = false;
    private amqp: RequireResult | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private onReconnectCallbacks: Set<OnReconnectCallback> = new Set();

    public constructor(
        private readonly config: AmqpConfig,
        private readonly logger: AbstractLogger,
    ) {}

    public isConnected(): boolean {
        return this.connected;
    }

    /**
     * Register a callback invoked after every successful reconnect. The
     * QueueService uses this to re-declare queues and re-register consumers
     * on the fresh connection (channels are connection-scoped and do not
     * survive a reconnect).
     */
    public onReconnect(callback: OnReconnectCallback): void {
        this.onReconnectCallbacks.add(callback);
    }

    /**
     * Establish the initial connection. Loads amqplib lazily so the dependency
     * is only required by projects that actually use the connector.
     *
     * Guarded against the closed flag: if close() runs while a connect() is in
     * flight, any freshly opened connection is immediately closed and the
     * connector stays stopped.
     */
    public async connect(): Promise<void> {
        if (this.closed) {
            return;
        }

        if (this.connected || this.connecting) {
            return;
        }

        this.connecting = true;

        if (!this.amqp) {
            this.amqp = this.loadAmqplib();
        }

        this.logger.info(`[${AmqpConnection.LoggerTag}] Connecting to ${this.config.host}:${this.config.port}/${this.config.vhost ?? '/'} ...`);

        try {
            const connection: AmqpChannelModel = await this.amqp.connect(this.buildConnectOptions());

            // close() may have run while we were awaiting the connection.
            // Tear down the orphan connection and stay stopped.
            if (this.closed) {
                await connection.close().catch((): void => {});
                return;
            }

            this.connection = connection;
            this.attachConnectionHandlers();
            this.connected = true;
            this.logger.info(`[${AmqpConnection.LoggerTag}] Connected.`);
        } catch (e) {
            this.logger.error(`[${AmqpConnection.LoggerTag}] Initial connection failed: ${(e as Error).message}`);
            // Self-heal: schedule a retry so a broker that is down at startup
            // doesn't permanently disable the connector. Mirrors the reconnect
            // behaviour used after a connection drop.
            if (!this.closed) {
                this.scheduleReconnect();
            }
        } finally {
            this.connecting = false;
        }
    }

    /**
     * Gracefully close the connection and all channels. After close() the
     * connector is permanently stopped (closed flag) - it will not reconnect.
     * Cancels any pending reconnect timer so it doesn't keep the event loop
     * alive past shutdown.
     */
    public async close(): Promise<void> {
        this.closed = true;
        this.connected = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.publishChannel) {
            try {
                await this.publishChannel.close();
            } catch (e) {
                this.logger.warning(`[${AmqpConnection.LoggerTag}] Error closing publish channel: ${(e as Error).message}`);
            }
            this.publishChannel = null;
        }

        if (this.connection) {
            try {
                await this.connection.close();
            } catch (e) {
                this.logger.warning(`[${AmqpConnection.LoggerTag}] Error closing connection: ${(e as Error).message}`);
            }
            this.connection = null;
        }

        this.logger.info(`[${AmqpConnection.LoggerTag}] Closed.`);
    }

    /**
     * Returns the shared confirm channel for publishing, creating it lazily on
     * first use (or re-creating it after a reconnect or channel-level close
     * invalidated the cache). Use this from QueuePublisher only - never share
     * it with consumers.
     */
    public async getPublishChannel(): Promise<AmqpConfirmChannel> {
        if (!this.connected || !this.connection) {
            throw new Error(`[${AmqpConnection.LoggerTag}] Cannot get publish channel: not connected.`);
        }

        if (this.publishChannel) {
            return this.publishChannel;
        }

        const channel: AmqpConfirmChannel = await this.connection.createConfirmChannel();
        // A confirm channel can die independently of the connection (e.g. broker
        // closes it after a publish to a non-existent exchange with mandatory
        // flag). Invalidate the cache so the next call opens a fresh channel.
        channel.on('close', (): void => {
            this.logger.debug(`[${AmqpConnection.LoggerTag}] Publish channel closed.`);
            this.publishChannel = null;
        });
        channel.on('error', (err: Error): void => {
            this.logger.error(`[${AmqpConnection.LoggerTag}] Publish channel error: ${err.message}`);
        });
        this.publishChannel = channel;
        this.logger.debug(`[${AmqpConnection.LoggerTag}] Publish channel created.`);
        return channel;
    }

    /**
     * Create a dedicated channel for a consumer with the given prefetch count.
     * Each consumer must own its channel: prefetch is per-channel, and a
     * channel-level broker error would otherwise take down unrelated consumers.
     */
    public async createConsumerChannel(prefetch: number): Promise<AmqpChannel> {
        if (!this.connected || !this.connection) {
            throw new Error(`[${AmqpConnection.LoggerTag}] Cannot create consumer channel: not connected.`);
        }

        const channel: AmqpChannel = await this.connection.createChannel();
        await channel.prefetch(prefetch);
        this.logger.debug(`[${AmqpConnection.LoggerTag}] Consumer channel created (prefetch=${prefetch}).`);
        return channel;
    }

    /**
     * Low-level publish primitive exposed for advanced use cases. QueuePublisher
     * is the preferred high-level facade. The channel used is the shared
     * confirm channel, so this method blocks on broker confirmation.
     */
    public async publish(
        exchange: string,
        routingKey: string,
        content: Buffer,
        options?: AmqpPublishOptions,
    ): Promise<void> {
        const channel: AmqpConfirmChannel = await this.getPublishChannel();
        channel.publish(exchange, routingKey, content, options);
        await channel.waitForConfirms();
    }

    private attachConnectionHandlers(): void {
        if (!this.connection) {
            return;
        }

        this.connection.on('error', (err: Error): void => {
            this.logger.error(`[${AmqpConnection.LoggerTag}] Connection error: ${err.message}`);
        });

        this.connection.on('close', (): void => {
            this.logger.warning(`[${AmqpConnection.LoggerTag}] Connection closed.`);
            this.connected = false;
            this.publishChannel = null;
            if (!this.closed) {
                this.scheduleReconnect();
            }
        });
    }

    private scheduleReconnect(): void {
        if (this.reconnecting) {
            return;
        }

        this.reconnecting = true;
        const delay: number = this.config.reconnectDelay ?? 5000;
        this.logger.info(`[${AmqpConnection.LoggerTag}] Reconnecting in ${delay}ms ...`);

        this.reconnectTimer = setTimeout(async (): Promise<void> => {
            this.reconnectTimer = null;
            this.reconnecting = false;
            if (this.closed) {
                return;
            }

            try {
                await this.connect();
                if (!this.connected) {
                    return;
                }
                // Re-setup consumers on the fresh connection. Channels are
                // connection-scoped, so every consumer needs a new channel and
                // a fresh consume() registration.
                await this.notifyReconnect();
            } catch (e) {
                this.logger.error(`[${AmqpConnection.LoggerTag}] Reconnect failed: ${(e as Error).message}`);
                this.scheduleReconnect();
            }
        }, delay);
    }

    private async notifyReconnect(): Promise<void> {
        for (const callback of this.onReconnectCallbacks) {
            try {
                await callback();
            } catch (e) {
                this.logger.error(`[${AmqpConnection.LoggerTag}] onReconnect callback failed: ${(e as Error).message}`);
            }
        }
    }

    /**
     * Build the connect options object passed to amqplib.connect(). Using the
     * object form (instead of an amqp:// URL) avoids URL-encoding pitfalls:
     * passwords containing '@', ':', '/' or other reserved characters would
     * break a URL string, but are passed verbatim through the options object.
     */
    private buildConnectOptions(): object {
        return {
            protocol: 'amqp',
            hostname: this.config.host,
            port: this.config.port,
            username: this.config.user,
            password: this.config.password,
            vhost: this.config.vhost ?? '/',
            heartbeat: this.config.heartbeat ?? 30,
            locale: 'en_US',
        };
    }

    private loadAmqplib(): RequireResult {
        try {
            // CommonJS dynamic require - avoids a top-level import that would
            // make amqplib a hard runtime dependency.
            return require('amqplib') as RequireResult;
        } catch {
            throw new Error(
                `[${AmqpConnection.LoggerTag}] The 'amqplib' package is required to use the AMQP connector. ` +
                `Install it with: npm install amqplib`,
            );
        }
    }
}