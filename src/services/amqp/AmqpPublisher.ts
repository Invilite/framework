import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {AmqpConnection} from "../../infrastructure/Queue/AmqpConnection";
import {AmqpPublishOptions} from "../../infrastructure/Queue/AmqpTypes";
import type {AmqpConfirmChannel} from "../../infrastructure/Queue/AmqpTypes";

/**
 * Facade for publishing messages to AMQP queues and exchanges. Registered in
 * the ServiceContainer as 'AmqpPublisher'; controllers and services publish
 * via `serviceContainer.get<AmqpPublisher>('AmqpPublisher')`.
 *
 * Uses the shared confirm channel from AmqpConnection (separate from consumer
 * channels). Publishes are
 * fire-and-forget: the broker confirms asynchronously, and errors surface as
 * 'error' events on the channel (handled by AmqpConnection, which invalidates
 * the cached channel). Callers that need synchronous certainty before
 * continuing (e.g. before committing a DB transaction) call waitForConfirms().
 *
 * Payloads are always JSON-serialised to a Buffer; the default contentType is
 * 'application/json' so consumers can parse symmetrically. Messages are
 * persistent by default so they survive a broker restart (durable queues alone
 * don't protect message contents - the persistent flag does).
 *
 * Publishes are fire-and-forget: the boolean backpressure signal returned by
 * the channel is ignored. Callers publishing at high volume should call
 * waitForConfirms() periodically so the channel's write buffer doesn't grow
 * unbounded when the broker falls behind.
 */
export class AmqpPublisher {
    private static readonly LoggerTag: string = 'AmqpPublisher';

    public constructor(
        private readonly connection: AmqpConnection,
        private readonly logger: AbstractLogger,
    ) {}

    /**
     * Publish a message to a queue via the default exchange (routing key = queue
     * name). The payload is JSON-serialised. Returns once the message is handed
     * to the channel; call waitForConfirms() to block until the broker
     * acknowledges.
     */
    public async publish(queue: string, payload: unknown, options?: AmqpPublishOptions): Promise<void> {
        const channel: AmqpConfirmChannel = await this.connection.getPublishChannel();
        const content: Buffer = this.serialize(payload);
        const merged: AmqpPublishOptions = this.mergeOptions(options);
        this.logger.trace(`[${AmqpPublisher.LoggerTag}] Publishing to queue '${queue}'.`);
        try {
            channel.sendToQueue(queue, content, merged);
        } catch (e) {
            this.logger.warning(`[${AmqpPublisher.LoggerTag}] sendToQueue threw on queue '${queue}': ${(e as Error).message}`);
            throw e;
        }
    }

    /**
     * Publish a message to an exchange with a routing key. The payload is
     * JSON-serialised. Returns once the message is handed to the channel; call
     * waitForConfirms() to block until the broker acknowledges.
     */
    public async publishToExchange(
        exchange: string,
        routingKey: string,
        payload: unknown,
        options?: AmqpPublishOptions,
    ): Promise<void> {
        const channel: AmqpConfirmChannel = await this.connection.getPublishChannel();
        const content: Buffer = this.serialize(payload);
        const merged: AmqpPublishOptions = this.mergeOptions(options);
        this.logger.trace(`[${AmqpPublisher.LoggerTag}] Publishing to exchange '${exchange}' with key '${routingKey}'.`);
        try {
            channel.publish(exchange, routingKey, content, merged);
        } catch (e) {
            this.logger.warning(`[${AmqpPublisher.LoggerTag}] publish threw on exchange '${exchange}' (key '${routingKey}'): ${(e as Error).message}`);
            throw e;
        }
    }

    /**
     * Block until the broker has acknowledged all publishes pending on the
     * shared confirm channel - including any published concurrently while
     * waiting. Use after a batch of publishes when you need certainty that the
     * broker has accepted them (e.g. before committing a DB transaction that
     * records the work as dispatched).
     */
    public async waitForConfirms(): Promise<void> {
        const channel: AmqpConfirmChannel = await this.connection.getPublishChannel();
        await channel.waitForConfirms();
    }

    /**
     * JSON-serialise the payload to a Buffer. Throws on circular references and
     * BigInt values. Functions are silently omitted by JSON.stringify (dropped
     * from objects, replaced with null in arrays) - validate the payload
     * upstream if that matters.
     */
    private serialize(payload: unknown): Buffer {
        return Buffer.from(JSON.stringify(payload), 'utf8');
    }

    private mergeOptions(options?: AmqpPublishOptions): AmqpPublishOptions {
        return {
            persistent: true,
            contentType: 'application/json',
            ...options,
        };
    }
}