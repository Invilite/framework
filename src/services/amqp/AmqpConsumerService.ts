import 'reflect-metadata';
import fs from "fs";
import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {Class, Path} from "../../utils";
import ServiceContainer from "../../infrastructure/ServiceContainer";
import {AmqpConnection} from "../../infrastructure/Queue/AmqpConnection";
import {AbstractQueueConsumer} from "../../infrastructure/Queue/AbstractQueueConsumer";
import {QueueConsumerDefinition} from "../../decorators/Queue/QueueConsumer";

type ConsumerInfo = {
    modulePath: string;
    className: string;
    definition: QueueConsumerDefinition;
};

/**
 * Discovers @QueueConsumer classes under a queues directory, instantiates
 * them, and manages their lifecycle: start on bootstrap, resubscribe on
 * reconnect, stop on shutdown. Analogous to TaskService for @Task classes.
 *
 * Discovery mirrors TaskService.registerTasks: scan the directory recursively,
 * filter by *Consumer.js/.ts suffix, require each file, and select classes that
 * carry the IsQueueConsumer metadata AND extend AbstractQueueConsumer.
 *
 * Reconnect handling: registers an onReconnect callback with AmqpConnection so
 * that after the broker connection is restored every running consumer gets a
 * fresh channel and re-registers its consume() (channels are connection-scoped
 * and do not survive a reconnect).
 *
 * Not registered in the ServiceContainer - instantiated in the bootstrap (like
 * TaskService). The publishing side is a separate AmqpPublisher (registered as
 * 'AmqpPublisher') so controllers get a narrow publish-only interface via DI
 * instead of this lifecycle orchestrator.
 */
export class AmqpConsumerService {
    private static readonly LoggerTag: string = 'AmqpConsumerService';

    private readonly consumers: Map<string, AbstractQueueConsumer> = new Map();
    private readonly discovered: Map<string, ConsumerInfo> = new Map();

    public constructor(
        private readonly logger: AbstractLogger,
        private readonly queuesPath: string,
        private readonly connection: AmqpConnection,
        private readonly serviceContainer: ServiceContainer,
    ) {
        this.registerConsumers(queuesPath);
        this.connection.onReconnect((): Promise<void> => this.handleReconnect());
    }

    /**
     * Discover consumer classes, instantiate them, and start consumption.
     * Called once on bootstrap. A consumer that fails to start is logged and
     * skipped so one broken queue doesn't block the rest.
     */
    public async startAll(): Promise<void> {
        for (const [queue, info] of this.discovered) {
            try {
                const instance: AbstractQueueConsumer = this.instantiate(info);
                await instance.start(info.definition);
                this.consumers.set(queue, instance);
                this.logger.info(`[${AmqpConsumerService.LoggerTag}] Started consumer "${info.className}" for queue "${queue}".`);
            } catch (e) {
                this.logger.error(`[${AmqpConsumerService.LoggerTag}] Failed to start consumer for queue "${queue}" (${info.className}): ${(e as Error).message}`);
            }
        }
    }

    /**
     * Stop every running consumer and clear the registry. Safe to call when
     * nothing is running (no-op for each stopped consumer).
     *
     * The map is cleared BEFORE awaiting stops so a reconnect firing mid-stop
     * finds an empty map (resubscribeAll becomes a no-op) instead of
     * resubscribing consumers that are being torn down.
     */
    public async stopAll(): Promise<void> {
        const snapshot: Map<string, AbstractQueueConsumer> = new Map(this.consumers);
        this.consumers.clear();

        const stopping: Promise<void>[] = [];
        for (const [queue, consumer] of snapshot) {
            stopping.push(consumer.stop().catch((error: Error): void => {
                this.logger.warning(`[${AmqpConsumerService.LoggerTag}] Error stopping consumer for queue "${queue}": ${error.message}`);
            }));
        }
        await Promise.all(stopping);
        this.logger.info(`[${AmqpConsumerService.LoggerTag}] All consumers stopped.`);
    }

    public async resubscribeAll(): Promise<void> {
        const resubscribing: Promise<void>[] = [];
        for (const [queue, consumer] of this.consumers) {
            resubscribing.push(consumer.resubscribe().catch((error: Error): void => {
                this.logger.error(`[${AmqpConsumerService.LoggerTag}] Failed to resubscribe consumer for queue "${queue}" after reconnect: ${error.message}`);
            }));
        }
        await Promise.all(resubscribing);
    }

    public async handleReconnect(): Promise<void> {
        await this.resubscribeAll();

        // Start consumers that were discovered but failed to start (broker
        // was down at boot). Without this they'd stay dead forever even after
        // the connection is restored, because startAll() only runs once.
        for (const [queue, info] of this.discovered) {
            if (this.consumers.has(queue)) {
                continue;
            }
            try {
                const instance: AbstractQueueConsumer = this.instantiate(info);
                await instance.start(info.definition);
                this.consumers.set(queue, instance);
                this.logger.info(`[${AmqpConsumerService.LoggerTag}] Started consumer "${info.className}" for queue "${queue}" after reconnect.`);
            } catch (e) {
                this.logger.error(`[${AmqpConsumerService.LoggerTag}] Failed to start consumer for queue "${queue}" after reconnect (${info.className}): ${(e as Error).message}`);
            }
        }
    }

    public getConsumers(): Map<string, AbstractQueueConsumer> {
        return this.consumers;
    }

    private instantiate(info: ConsumerInfo): AbstractQueueConsumer {
        const exports: Record<string, unknown> = require(info.modulePath) as Record<string, unknown>;
        const ConsumerClass: new (connection: AmqpConnection, logger: AbstractLogger, serviceContainer: ServiceContainer) => AbstractQueueConsumer = exports[info.className] as new (
            connection: AmqpConnection,
            logger: AbstractLogger,
            serviceContainer: ServiceContainer,
        ) => AbstractQueueConsumer;
        // Dependencies mirror AbstractController's controllerParameters:
        // connection, logger, and the ServiceContainer for resolving deps.
        return new ConsumerClass(this.connection, this.logger, this.serviceContainer);
    }

    private registerConsumers(queuesPath: string): void {
        const basePath: string = Path.resolve(queuesPath);

        this.logger.trace(`[${AmqpConsumerService.LoggerTag}] Searching for consumers in "${basePath}" ...`);

        let files: string[];
        try {
            files = fs.readdirSync(basePath, {encoding: 'utf8', recursive: true});
        } catch (e) {
            this.logger.error(`[${AmqpConsumerService.LoggerTag}] Cannot read queues directory "${basePath}": ${(e as Error).message}`);
            return;
        }

        files.filter((file: string): boolean => file.endsWith("Consumer.js") || file.endsWith("Consumer.ts"))
            .forEach((file: string): void => {
                try {
                    const modulePath: string = Path.resolve(basePath, file);
                    const exports: Record<string, unknown> = require(modulePath) as Record<string, unknown>;
                    const modulePropertyNames: string[] = Object.keys(exports);

                    for (const className of modulePropertyNames) {
                        const target: unknown = exports[className];

                        if (typeof target !== 'function') {
                            continue;
                        }

                        const isConsumer: boolean = Reflect.getMetadata('IsQueueConsumer', target) === true;
                        const definition: QueueConsumerDefinition | undefined = Reflect.getMetadata('QueueConsumerDefinition', target);

                        if (!isConsumer) {
                            this.logger.trace(`[${AmqpConsumerService.LoggerTag}] Bypassing class "${className}" (not a @QueueConsumer).`);
                            continue;
                        }

                        if (!Class.isInheritedFrom(target as new (...args: unknown[]) => object, AbstractQueueConsumer)) {
                            this.logger.warning(`[${AmqpConsumerService.LoggerTag}] Bypassing class "${className}" (@QueueConsumer present but doesn't extend AbstractQueueConsumer).`);
                            continue;
                        }

                        if (!definition) {
                            this.logger.warning(`[${AmqpConsumerService.LoggerTag}] Missing QueueConsumerDefinition metadata on "${className}" in "${file}".`);
                            continue;
                        }

                        const queue: string = definition.queue;
                        if (this.discovered.has(queue)) {
                            const existing: ConsumerInfo = this.discovered.get(queue)!;
                            this.logger.warning(`[${AmqpConsumerService.LoggerTag}] Class "${className}" cannot consume queue "${queue}": already consumed by "${existing.className}".`);
                            continue;
                        }

                        this.logger.trace(`[${AmqpConsumerService.LoggerTag}] Registering class "${className}" for queue "${queue}".`);
                        this.discovered.set(queue, {modulePath, className, definition});
                    }
                } catch (e) {
                    this.logger.emergency(`[${AmqpConsumerService.LoggerTag}] Error while registering consumer from file ${file}:`, e);
                }
            });
    }
}