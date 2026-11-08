/**
 * Minimal structural interfaces matching the subset of amqplib's API surface
 * that this connector uses. Defined locally (not imported from 'amqplib') so
 * that projects don't need @types/amqplib installed unless they actually use
 * the AMQP connector. TypeScript's structural typing makes the real amqplib
 * objects assignable to these narrower interfaces.
 */

export interface AmqpMessageProperties {
    contentType?: string;
    contentEncoding?: string;
    headers?: Record<string, unknown>;
    deliveryMode?: number;
    priority?: number;
    correlationId?: string;
    replyTo?: string;
    expiration?: string | number;
    messageId?: string;
    timestamp?: number;
    type?: string;
    userId?: string;
    appId?: string;
    clusterId?: string;
}

export interface AmqpMessageFields {
    deliveryTag: number;
    redelivered: boolean;
    exchange: string;
    routingKey: string;
    consumerTag?: string;
    messageCount?: number;
}

export interface AmqpConsumeMessage {
    content: Buffer;
    fields: AmqpMessageFields;
    properties: AmqpMessageProperties;
}

export interface AmqpAssertQueueOptions {
    exclusive?: boolean;
    durable?: boolean;
    autoDelete?: boolean;
    arguments?: Record<string, unknown>;
    messageTtl?: number;
    expires?: number;
    deadLetterExchange?: string;
    deadLetterRoutingKey?: string;
    maxLength?: number;
    maxPriority?: number;
}

export interface AmqpAssertExchangeOptions {
    durable?: boolean;
    internal?: boolean;
    autoDelete?: boolean;
    alternateExchange?: string;
    arguments?: Record<string, unknown>;
}

export interface AmqpPublishOptions {
    expiration?: string | number;
    userId?: string;
    mandatory?: boolean;
    persistent?: boolean;
    deliveryMode?: boolean | number;
    contentType?: string;
    contentEncoding?: string;
    headers?: Record<string, unknown>;
    priority?: number;
    correlationId?: string;
    replyTo?: string;
    messageId?: string;
    timestamp?: number;
    type?: string;
    appId?: string;
}

export interface AmqpConsumeOptions {
    consumerTag?: string;
    noLocal?: boolean;
    noAck?: boolean;
    exclusive?: boolean;
    priority?: number;
    arguments?: Record<string, unknown>;
}

export namespace AmqpReplies {
    export interface AssertQueue {
        queue: string;
        messageCount: number;
        consumerCount: number;
    }
    export interface AssertExchange {
        exchange: string;
    }
    export interface Consume {
        consumerTag: string;
    }
    export interface Empty {}
}

export type AmqpExchangeType = "direct" | "topic" | "headers" | "fanout" | "match";

/**
 * Subset of amqplib's Channel interface used by the connector and consumers.
 * Channels are not thread-safe: each consumer must own a dedicated channel,
 * and the publisher must use a separate confirm channel.
 */
export interface AmqpChannel {
    close(): Promise<void>;
    assertQueue(queue: string, options?: AmqpAssertQueueOptions): Promise<AmqpReplies.AssertQueue>;
    assertExchange(
        exchange: string,
        type: AmqpExchangeType | string,
        options?: AmqpAssertExchangeOptions,
    ): Promise<AmqpReplies.AssertExchange>;
    bindQueue(queue: string, source: string, pattern: string, args?: Record<string, unknown>): Promise<AmqpReplies.Empty>;
    consume(
        queue: string,
        onMessage: (message: AmqpConsumeMessage | null) => void,
        options?: AmqpConsumeOptions,
    ): Promise<AmqpReplies.Consume>;
    cancel(consumerTag: string): Promise<AmqpReplies.Empty>;
    prefetch(count: number, global?: boolean): Promise<AmqpReplies.Empty>;
    ack(message: AmqpConsumeMessage, allUpTo?: boolean): void;
    nack(message: AmqpConsumeMessage, allUpTo?: boolean, requeue?: boolean): void;
    reject(message: AmqpConsumeMessage, requeue?: boolean): void;
    publish(exchange: string, routingKey: string, content: Buffer, options?: AmqpPublishOptions): boolean;
    sendToQueue(queue: string, content: Buffer, options?: AmqpPublishOptions): boolean;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}

/**
 * Confirm channel extends a regular channel with publisher confirms semantics,
 * allowing the broker to acknowledge that a published message was received.
 */
export interface AmqpConfirmChannel extends AmqpChannel {
    publish(
        exchange: string,
        routingKey: string,
        content: Buffer,
        options?: AmqpPublishOptions,
        callback?: (err: Error | null, ok: AmqpReplies.Empty) => void,
    ): boolean;
    sendToQueue(
        queue: string,
        content: Buffer,
        options?: AmqpPublishOptions,
        callback?: (err: Error | null, ok: AmqpReplies.Empty) => void,
    ): boolean;
    waitForConfirms(): Promise<void>;
}

export interface AmqpChannelModel {
    close(): Promise<void>;
    createChannel(): Promise<AmqpChannel>;
    createConfirmChannel(): Promise<AmqpConfirmChannel>;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}