import 'reflect-metadata';
import {AmqpAssertExchangeOptions, AmqpExchangeType} from "../../infrastructure/Queue/AmqpTypes";

/**
 * Full exchange declaration. The name and type are required when an exchange is
 * used; the rest are optional broker-side declaration options. Combining name,
 * type, and declaration options into one object lets a single exchange
 * definition be reused across multiple queues/consumers.
 */
export interface QueueConsumerExchangeOptions extends AmqpAssertExchangeOptions {
    name: string;
    type: AmqpExchangeType;
}

/**
 * Optional configuration applied on top of the positional queue/routingKey.
 * Kept small so a single shared object can be passed to many @QueueConsumer
 * decorators that differ only in queue name.
 */
export interface QueueConsumerOptions {
    /** Per-channel prefetch count. Defaults to 1 (fair dispatch). */
    prefetch?: number;
    /** Exchange to declare and bind the queue to. Omit for default exchange. */
    exchange?: QueueConsumerExchangeOptions;
    /** Dead-letter exchange for messages that cannot be processed. */
    deadLetterExchange?: string;
    /** Routing key for dead-lettered messages. Defaults to the original routing key. */
    deadLetterRoutingKey?: string;
    /** Whether the queue survives broker restarts. Defaults to true. */
    durable?: boolean;
    /** Whether the queue is deleted when the last consumer disconnects. Defaults to false. */
    autoDelete?: boolean;
}

/**
 * Resolved definition stored as reflect-metadata and passed to
 * AbstractQueueConsumer.start(). Combines the decorator's positional arguments
 * with the optional options, with defaults applied.
 */
export interface QueueConsumerDefinition {
    queue: string;
    routingKey: string;
    prefetch: number;
    exchange?: {
        name: string;
        type: AmqpExchangeType;
        options: AmqpAssertExchangeOptions;
    };
    deadLetterExchange?: string;
    deadLetterRoutingKey?: string;
    durable: boolean;
    autoDelete: boolean;
}

/**
 * Class decorator marking a class as a queue consumer. The queue name and
 * routing key are positional so a single shared options object can be reused
 * across many consumers (e.g. a common prefetch/DLX policy applied to several
 * queues).
 *
 * Usage:
 *   const shared = { prefetch: 10, deadLetterExchange: 'dlx' };
 *   @QueueConsumer('image.resize', 'resize', shared)
 *   export default class ImageResizeConsumer extends AbstractQueueConsumer { ... }
 *
 *   @QueueConsumer('image.optimize', 'optimize', shared)
 *   export default class ImageOptimizeConsumer extends AbstractQueueConsumer { ... }
 */
export const QueueConsumer: (queue: string, routingKey?: string, options?: QueueConsumerOptions) => ClassDecorator = (
    queue: string,
    routingKey?: string,
    options?: QueueConsumerOptions,
): ClassDecorator => {
    return (target: object): void => {
        const definition: QueueConsumerDefinition = resolveDefinition(queue, routingKey, options);
        Reflect.defineMetadata('IsQueueConsumer', true, target);
        Reflect.defineMetadata('QueueConsumerDefinition', definition, target);
    };
};

/**
 * Resolve the decorator arguments into a complete definition with defaults.
 * Runs at decoration time (class definition) so the metadata stored on the
 * class is already fully resolved and ready for AbstractQueueConsumer.start().
 */
function resolveDefinition(
    queue: string,
    routingKey?: string,
    options?: QueueConsumerOptions,
): QueueConsumerDefinition {
    const definition: QueueConsumerDefinition = {
        queue,
        routingKey: routingKey ?? queue,
        prefetch: options?.prefetch ?? 1,
        durable: options?.durable ?? true,
        autoDelete: options?.autoDelete ?? false,
    };

    if (options?.exchange) {
        const {name, type, ...assertOptions}: QueueConsumerExchangeOptions = options.exchange;
        definition.exchange = {name, type, options: assertOptions};
    }

    if (options?.deadLetterExchange) {
        definition.deadLetterExchange = options.deadLetterExchange;
    }
    if (options?.deadLetterRoutingKey) {
        definition.deadLetterRoutingKey = options.deadLetterRoutingKey;
    }

    return definition;
}