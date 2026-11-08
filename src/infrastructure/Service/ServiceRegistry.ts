import 'reflect-metadata';
import fs from "fs";
import path from "path";
import ServiceContainer from "../ServiceContainer";
import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {getServiceName} from "../../decorators/Service/Service";
import {ServiceClass, ServiceContext, ServiceRegistration, ServiceStatus} from "../../types/types/ServiceTypes";
import {Class} from "../../utils/Class";
import {AbstractService} from "./AbstractService";

interface ServiceEntry<TContext extends ServiceContext> {
    name: string;
    target: ServiceClass<TContext>;
    modulePath: string | null;
    status: ServiceStatus;
    instance: AbstractService | null;
}

/**
 * Registry of live services (@Service on a class extending AbstractService). Discovers service classes in the given
 * directories (the application passes the `services/` directory of every domain), builds them through their static
 * create(context) factory, registers each instance in the ServiceContainer and drives initialize()/shutdown(). Live
 * services depend only on infrastructure carried by the context or the container, so no dependency graph is resolved -
 * order is the (sorted) discovery order.
 */
export class ServiceRegistry<TContext extends ServiceContext> {
    private readonly entries: ServiceEntry<TContext>[] = [];

    public constructor(
        private readonly logger: AbstractLogger,
        private readonly container: ServiceContainer,
    ) {}

    /** Declaration files and source maps sit next to compiled .js files in build/. */
    public static isServiceModule(file: string): boolean {
        return /\.(js|ts)$/.test(file) && !file.endsWith('.d.ts');
    }

    /**
     * Requires every module in the given directories (recursively) and registers classes decorated with @Service.
     * Modules are loaded in sorted path order (readdir order is not guaranteed). Modules must be free of import-time
     * side effects - every file in a scanned directory is required, decorated or not. A missing directory is skipped.
     */
    public scan(paths: string[]): void {
        const modulePaths: string[] = [];
        for (const servicesPath of paths) {
            if (!fs.existsSync(servicesPath)) {
                this.logger.warning(`[ServiceRegistry] Services directory "${servicesPath}" does not exist - skipping.`);
                continue;
            }
            const files: string[] = fs.readdirSync(servicesPath, {encoding: 'utf8', recursive: true}) as string[];
            for (const file of files) {
                if (ServiceRegistry.isServiceModule(file)) {
                    modulePaths.push(path.resolve(servicesPath, file));
                }
            }
        }

        for (const modulePath of modulePaths.sort()) {
            const module: Record<string, unknown> = require(modulePath);
            for (const exported of Object.values(module)) {
                if (typeof exported !== 'function' || getServiceName(exported) === undefined) {
                    continue;
                }
                this.register(exported as unknown as ServiceClass<TContext>, modulePath);
            }
        }
    }

    public register(target: ServiceClass<TContext>, modulePath: string | null = null): void {
        const name: string | undefined = getServiceName(target as unknown as Function);
        if (name === undefined) {
            throw new Error(`[ServiceRegistry] Class "${target.name}" is not decorated with @Service`);
        }
        if (!Class.isInheritedFrom(target as unknown as new () => object, AbstractService)) {
            throw new Error(`[ServiceRegistry] Service "${name}" (${target.name}) does not extend AbstractService`);
        }
        // The same class exported twice (named + default) is one service.
        if (this.entries.some((entry: ServiceEntry<TContext>): boolean => entry.target === target)) {
            return;
        }
        const clash: ServiceEntry<TContext> | undefined = this.entries.find((entry: ServiceEntry<TContext>): boolean => entry.name === name);
        if (clash !== undefined) {
            throw new Error(`[ServiceRegistry] Service name "${name}" is already used by class "${clash.target.name}"`);
        }
        this.entries.push({name, target, modulePath, status: 'registered', instance: null});
    }

    public create(context: TContext): void {
        for (const entry of this.entries) {
            if (entry.instance !== null) {
                continue;
            }
            if (this.container.has(entry.name)) {
                throw new Error(`[ServiceRegistry] Service name "${entry.name}" is already registered in the service container`);
            }
            const instance: unknown = entry.target.create(context);
            if (!(instance instanceof (entry.target as unknown as Function))) {
                throw new Error(`[ServiceRegistry] Factory of service "${entry.name}" did not return a ${entry.target.name}`);
            }
            entry.instance = instance as AbstractService;
            entry.status = 'created';
            this.container.register(entry.instance, entry.name);
        }
        this.logger.notice(`[ServiceRegistry] ${this.entries.length} service(s): ${this.entries.map((entry: ServiceEntry<TContext>): string => entry.name).join(', ')}`);
    }

    /** Initializes services in order; a throwing initialize() shuts down the initialized ones and rethrows. */
    public async initialize(): Promise<void> {
        for (const entry of this.entries) {
            if (entry.instance === null || entry.status === 'initialized') {
                continue;
            }
            try {
                await entry.instance.initialize();
                entry.status = 'initialized';
            } catch (error: unknown) {
                entry.status = 'failed';
                this.logger.error(`[ServiceRegistry] Service "${entry.name}" failed to initialize:`, error);
                await this.shutdown();
                throw error;
            }
        }
    }

    /** Shuts initialized services down in reverse order; one failing shutdown() does not block the rest. Idempotent. */
    public async shutdown(): Promise<void> {
        for (const entry of [...this.entries].reverse()) {
            if (entry.status !== 'initialized' || entry.instance === null) {
                continue;
            }
            try {
                await entry.instance.shutdown();
            } catch (error: unknown) {
                this.logger.error(`[ServiceRegistry] Service "${entry.name}" failed to shut down:`, error);
            }
            entry.status = 'shut down';
        }
    }

    public getInstances(): AbstractService[] {
        return this.entries
            .filter((entry: ServiceEntry<TContext>): boolean => entry.instance !== null)
            .map((entry: ServiceEntry<TContext>): AbstractService => entry.instance as AbstractService);
    }

    public getRegistrations(): ServiceRegistration[] {
        return this.entries.map((entry: ServiceEntry<TContext>): ServiceRegistration => ({
            name: entry.name,
            className: entry.target.name,
            modulePath: entry.modulePath,
            status: entry.status,
        }));
    }
}
