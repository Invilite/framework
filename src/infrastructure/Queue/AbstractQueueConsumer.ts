import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import ServiceContainer from "../../infrastructure/ServiceContainer";
import {AmqpConnection} from "./AmqpConnection";
import {
    AmqpChannel,
    AmqpConsumeMessage,
    AmqpConsumeOptions,
    AmqpAssertQueueOptions,
    AmqpReplies,
} from "./AmqpTypes";
import {QueueConsumerDefinition} from "../../decorators/Queue/QueueConsumer";

/**
 * Result returned by a consumer's onMessage handler. The base class uses it to
 * drive ack/nack/reject centrally, which keeps retry and dead-letter policy
 * consistent across all consumers.
 *
 *  - 'ack'    : message processed successfully, remove from queue
 *  - 'nack'   : processing failed, requeue for another attempt (default true)
 *  - 'reject' : drop the message (optionally to a dead-letter exchange)
 *  - { action: 'nack', requeue: boolean } : fail without requeue (to DLX if set)
 */
export type ConsumerResult = 'ack' | 'nack' | 'reject' | { action: 'nack'; requeue: boolean };

/**
 * Abstract base class for queue consumers, analogous to AbstractTask.
 *
 * CONSUMERS MUST BE IDEMPOTENT: messages may be redelivered (after a nack with
 * requeue, a broker restart with persistent messages, or a network glitch).
 * Treat each message as if it might have been partially processed before.
 *
 * Lifecycle:
 *   1. QueueService discovers @QueueConsumer classes, instantiates them
 *      (passing connection, logger, serviceContainer), and calls start() with
 *      the decorator options.
 *   2. start() declares the queue (and optional exchange + binding), sets
 *      prefetch, and begins consuming. Incoming messages are dispatched to
 *      onMessage(); the returned ConsumerResult drives ack/nack/reject.
 *   3. On reconnect, QueueService calls resubscribe() which tears down the old
 *      channel and re-runs the setup on a fresh channel.
 *   4. stop() cancels the consumer and closes the channel.
 */
export abstract class AbstractQueueConsumer {
    private static readonly LoggerTag: string = 'QueueConsumer';

    private channel: AmqpChannel | null = null;
    private consumerTag: string | null = null;
    private definition: QueueConsumerDefinition | null = null;
    private running: boolean = false;

    protected constructor(
        protected readonly connection: AmqpConnection,
        protected readonly logger: AbstractLogger,
        protected readonly serviceContainer: ServiceContainer,
    ) {}

    /**
     * Main message handler. Receives the raw AMQP message (content Buffer,
     * fields, properties). The consumer is responsible for deserializing the
     * payload - the base class intentionally does not assume JSON, so binary
     * and text payloads work without forced parsing.
     *
     * Return a ConsumerResult to tell the base class how to settle the message.
     * Throw to signal failure; the base class applies the default error policy
     * (nack with requeue, unless the message was already redelivered - then
     * reject to avoid an infinite retry loop).
     */
    protected abstract onMessage(message: AmqpConsumeMessage): Promise<ConsumerResult> | ConsumerResult;

    protected onConnected(): Promise<void> | void {}

    protected onError(error: Error, message: AmqpConsumeMessage): Promise<void> | void {}

    /**
     * Start consuming. Called by QueueService with the definition resolved by
     * the @QueueConsumer decorator (defaults already applied at decoration
     * time). Delegates to resubscribe() on a fresh channel.
     */
    public async start(definition: QueueConsumerDefinition): Promise<void> {
        if (this.running) {
            this.logger.warning(`[${AbstractQueueConsumer.LoggerTag}] Consumer for "${definition.queue}" already running.`);
            return;
        }

        this.definition = definition;
        await this.resubscribe();
        this.running = true;
        // onConnected is a post-setup hook; a throwing hook must not undo a
        // successful registration or leave QueueService thinking start failed.
        try {
            await this.onConnected();
        } catch (e) {
            this.logger.error(`[${AbstractQueueConsumer.LoggerTag}] onConnected hook threw on queue "${definition.queue}": ${(e as Error).message}`);
        }
    }

    /**
     * Re-create the consumer channel and re-register the consumer. Called
     * initially by start() and again by QueueService after a reconnect.
     * Safe to call multiple times: tears down any previous channel first.
     *
     * Not intended for application code; called by QueueService on reconnect.
     */
    public async resubscribe(): Promise<void> {
        if (!this.definition) {
            throw new Error(`[${AbstractQueueConsumer.LoggerTag}] Cannot resubscribe: consumer not started.`);
        }

        // Tear down the previous channel if it survived (e.g. connection-level
        // reconnect leaves the old channel object stale; close it defensively).
        await this.teardownChannel();

        const channel: AmqpChannel = await this.connection.createConsumerChannel(this.definition.prefetch);
        // If topology setup fails, close the freshly opened channel so it
        // doesn't leak on the connection (repeated failures would accumulate
        // channels until the broker's channel limit is hit).
        try {
            await this.setupTopology(channel, this.definition);
        } catch (e) {
            await channel.close().catch((): void => {});
            throw e;
        }
        this.channel = channel;

        const consumeOptions: AmqpConsumeOptions = { noAck: false };
        const result: AmqpReplies.Consume = await channel.consume(
            this.definition.queue,
            (message: AmqpConsumeMessage | null): void => {
                if (message === null) {
                    // Consumer cancelled by the broker.
                    this.logger.warning(`[${AbstractQueueConsumer.LoggerTag}] Consumer cancelled by broker for queue "${this.definition?.queue}".`);
                    this.consumerTag = null;
                    return;
                }
                void this.handleMessage(message);
            },
            consumeOptions,
        );
        this.consumerTag = result.consumerTag;
        this.logger.info(`[${AbstractQueueConsumer.LoggerTag}] Consuming queue "${this.definition.queue}" (tag=${result.consumerTag}).`);
    }

    public async stop(): Promise<void> {
        this.running = false;
        await this.teardownChannel();
        this.definition = null;
    }

    public isRunning(): boolean {
        return this.running;
    }

    public getQueueName(): string | null {
        return this.definition?.queue ?? null;
    }

    /**
     * Dispatch a message to onMessage and settle it according to the result.
     * Catches all handler errors and applies the default error policy.
     *
     * The channel reference is captured at the start and used for settlement,
     * NOT re-read from this.channel. Delivery tags are channel-scoped: if a
     * reconnect swaps this.channel mid-handler, settling on the new channel
     * with the old message's tag would trigger UNKNOWN_DELIVERY_TAG and close
     * the new channel. If the captured channel is gone, we skip settlement -
     * the broker redelivers the message once a new consumer is registered.
     */
    private async handleMessage(message: AmqpConsumeMessage): Promise<void> {
        const channel: AmqpChannel | null = this.channel;
        if (!channel) {
            return;
        }

        let result: ConsumerResult;
        try {
            result = await this.onMessage(message);
        } catch (error) {
            const err: Error = error as Error;
            this.logger.error(`[${AbstractQueueConsumer.LoggerTag}] Error handling message on queue "${this.definition?.queue}": ${err.message}`);
            try {
                await this.onError(err, message);
            } catch (onErrorErr) {
                this.logger.error(`[${AbstractQueueConsumer.LoggerTag}] onError hook threw: ${(onErrorErr as Error).message}`);
            }
            // Default error policy: requeue unless already redelivered, to
            // avoid an infinite retry loop on a poison message.
            this.settle(channel, message, message.fields.redelivered ? 'reject' : 'nack');
            return;
        }

        this.applyResult(channel, message, result);
    }

    /**
     * Settle a message on a specific channel. All settlement goes through here
     * so the channel reference is never stale after a reconnect. Errors from
     * settling on a closed channel are swallowed: the broker will redeliver.
     */
    private settle(channel: AmqpChannel, message: AmqpConsumeMessage, result: ConsumerResult): void {
        try {
            if (result === 'ack') {
                channel.ack(message);
            } else if (result === 'nack') {
                channel.nack(message, false, true);
            } else if (result === 'reject') {
                channel.reject(message, false);
            } else if (typeof result === 'object' && result.action === 'nack') {
                channel.nack(message, false, result.requeue);
            } else {
                // Unknown result shape is a programming error. Reject to a DLX
                // if configured, otherwise drop - never silently ack a message
                // whose processing state is unknown (that would lose data).
                this.logger.error(`[${AbstractQueueConsumer.LoggerTag}] Unknown ConsumerResult from onMessage on queue "${this.definition?.queue}"; rejecting to avoid silent loss.`);
                channel.reject(message, false);
            }
        } catch (e) {
            // Channel likely closed (reconnect in progress). The broker will
            // redeliver the message once a new consumer is registered.
            this.logger.debug(`[${AbstractQueueConsumer.LoggerTag}] Settlement failed (channel closed?): ${(e as Error).message}`);
        }
    }

    private applyResult(channel: AmqpChannel, message: AmqpConsumeMessage, result: ConsumerResult): void {
        this.settle(channel, message, result);
    }

    private async setupTopology(channel: AmqpChannel, def: QueueConsumerDefinition): Promise<void> {
        const queueOptions: AmqpAssertQueueOptions = {
            durable: def.durable,
            autoDelete: def.autoDelete,
        };
        if (def.deadLetterExchange) {
            queueOptions.deadLetterExchange = def.deadLetterExchange;
            if (def.deadLetterRoutingKey) {
                queueOptions.deadLetterRoutingKey = def.deadLetterRoutingKey;
            }
        }
        await channel.assertQueue(def.queue, queueOptions);

        if (def.exchange) {
            await channel.assertExchange(def.exchange.name, def.exchange.type, def.exchange.options);
            await channel.bindQueue(def.queue, def.exchange.name, def.routingKey);
        }
    }

    private async teardownChannel(): Promise<void> {
        if (this.consumerTag && this.channel) {
            try {
                await this.channel.cancel(this.consumerTag);
            } catch (e) {
                this.logger.debug(`[${AbstractQueueConsumer.LoggerTag}] cancel failed (channel likely gone): ${(e as Error).message}`);
            }
            this.consumerTag = null;
        }

        if (this.channel) {
            try {
                await this.channel.close();
            } catch (e) {
                this.logger.debug(`[${AbstractQueueConsumer.LoggerTag}] channel close failed: ${(e as Error).message}`);
            }
            this.channel = null;
        }
    }
}