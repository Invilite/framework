import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import ServiceContainer, {ContainerKey} from "../ServiceContainer";
import {getModuleOptions} from "../../decorators/Module/Module";
import {
    ModuleClass,
    ModuleContainer,
    ModuleContext,
    ModuleLookup,
    ModuleOptions,
    ModuleRegistration,
    ModuleResources,
    ModuleStatus,
} from "../../types/types/ModuleTypes";

interface ModuleEntry<TContext extends ModuleContext> {
    name: string;
    target: ModuleClass<TContext>;
    modulePath: string | null;
    after: string[];
    status: ModuleStatus;
    instance: object | null;
}

/**
 * Registry of domain modules (@Module). Loads the module file of every domain, creates the modules in topological
 * order of their `after` names and gives each one the application resources plus the library fields (logger, container
 * view and the modules it declared). Modules have no lifecycle: services own timers and subscriptions.
 */
export class ModuleRegistry<TContext extends ModuleContext> {
    private readonly entries: ModuleEntry<TContext>[] = [];
    private created: boolean = false;

    public constructor(
        private readonly logger: AbstractLogger,
        private readonly container: ServiceContainer,
    ) {}

    public load(modulePaths: string[]): void {
        for (const modulePath of modulePaths) {
            const moduleExports: Record<string, unknown> = require(modulePath);
            const targets: ModuleClass<TContext>[] = [];
            for (const exported of Object.values(moduleExports)) {
                if (typeof exported !== 'function' || getModuleOptions(exported) === undefined) {
                    continue;
                }
                // The same class exported twice (named + default) is one module.
                if (!targets.includes(exported as unknown as ModuleClass<TContext>)) {
                    targets.push(exported as unknown as ModuleClass<TContext>);
                }
            }
            if (targets.length === 0) {
                throw new Error(`[ModuleRegistry] File "${modulePath}" exports no class decorated with @Module`);
            }
            if (targets.length > 1) {
                throw new Error(`[ModuleRegistry] File "${modulePath}" exports more than one @Module class`);
            }
            this.register(targets[0], modulePath);
        }
    }

    public register(target: ModuleClass<TContext>, modulePath: string | null = null): void {
        const options: ModuleOptions | undefined = getModuleOptions(target as unknown as Function);
        if (options === undefined) {
            throw new Error(`[ModuleRegistry] Class "${target.name}" is not decorated with @Module`);
        }
        if (this.entries.some((entry: ModuleEntry<TContext>): boolean => entry.target === target)) {
            return;
        }
        const clash: ModuleEntry<TContext> | undefined = this.entries.find((entry: ModuleEntry<TContext>): boolean => entry.name === options.name);
        if (clash !== undefined) {
            throw new Error(`[ModuleRegistry] Module name "${options.name}" is already used by class "${clash.target.name}"`);
        }
        this.entries.push({
            name: options.name,
            target,
            modulePath,
            after: options.after !== undefined ? [...options.after] : [],
            status: 'registered',
            instance: null,
        });
    }

    public create(resources: ModuleResources<TContext>): void {
        if (this.created) {
            throw new Error('[ModuleRegistry] Modules are already created');
        }
        this.created = true;

        this.validateAfter();
        const order: string[] = this.resolveOrder();
        const entriesByName: Map<string, ModuleEntry<TContext>> = new Map(
            this.entries.map((entry: ModuleEntry<TContext>): [string, ModuleEntry<TContext>] => [entry.name, entry]),
        );

        for (const name of order) {
            const entry: ModuleEntry<TContext> = entriesByName.get(name) as ModuleEntry<TContext>;
            const context: TContext = {
                ...resources,
                logger: this.logger,
                container: this.containerView(),
                modules: this.lookupFor(entry),
            } as TContext;
            try {
                entry.instance = new entry.target(context);
                entry.status = 'created';
            } catch (error: unknown) {
                entry.status = 'failed';
                this.logger.error(`[ModuleRegistry] Module "${entry.name}" failed to create:`, error);
                throw error;
            }
        }

        this.logger.notice(`[ModuleRegistry] ${order.length} module(s): ${order.join(', ')}`);
    }

    public get<TModule extends object>(target: ContainerKey<TModule>): TModule {
        const entry: ModuleEntry<TContext> | undefined = this.findEntry(target as unknown as Function);
        if (entry === undefined) {
            throw new Error(`[ModuleRegistry] Class "${target.name}" is not a registered module`);
        }
        if (entry.instance === null) {
            throw new Error(`[ModuleRegistry] Module "${entry.name}" is not created`);
        }
        return entry.instance as TModule;
    }

    public getRegistrations(): ModuleRegistration[] {
        return this.entries.map((entry: ModuleEntry<TContext>): ModuleRegistration => ({
            name: entry.name,
            className: entry.target.name,
            modulePath: entry.modulePath,
            after: [...entry.after],
            status: entry.status,
        }));
    }

    private validateAfter(): void {
        for (const entry of this.entries) {
            if (entry.after.includes(entry.name)) {
                throw new Error(`[ModuleRegistry] Module "${entry.name}" lists itself in after`);
            }
        }
        const names: Set<string> = new Set(this.entries.map((entry: ModuleEntry<TContext>): string => entry.name));
        for (const entry of this.entries) {
            for (const dependency of entry.after) {
                if (!names.has(dependency)) {
                    throw new Error(`[ModuleRegistry] Module "${entry.name}" lists unknown module "${dependency}" in after`);
                }
            }
        }
    }

    private resolveOrder(): string[] {
        const indegree: Map<string, number> = new Map<string, number>();
        const dependents: Map<string, string[]> = new Map<string, string[]>();
        for (const entry of this.entries) {
            const dependencies: Set<string> = new Set(entry.after);
            indegree.set(entry.name, dependencies.size);
            for (const dependency of dependencies) {
                const list: string[] = dependents.get(dependency) ?? [];
                list.push(entry.name);
                dependents.set(dependency, list);
            }
        }

        const ready: string[] = [...indegree.entries()]
            .filter(([, count]: [string, number]): boolean => count === 0)
            .map(([name]: [string, number]): string => name)
            .sort();
        const order: string[] = [];
        while (ready.length > 0) {
            const name: string = ready.shift() as string;
            order.push(name);
            for (const dependent of dependents.get(name) ?? []) {
                const count: number = (indegree.get(dependent) as number) - 1;
                indegree.set(dependent, count);
                if (count === 0) {
                    ready.push(dependent);
                    ready.sort();
                }
            }
        }

        if (order.length < this.entries.length) {
            throw new Error(`[ModuleRegistry] Cycle in after: ${this.findCycle(indegree)}`);
        }
        return order;
    }

    private findCycle(indegree: Map<string, number>): string {
        const remaining: Set<string> = new Set(
            [...indegree.entries()]
                .filter(([, count]: [string, number]): boolean => count > 0)
                .map(([name]: [string, number]): string => name),
        );
        const entriesByName: Map<string, ModuleEntry<TContext>> = new Map(
            this.entries.map((entry: ModuleEntry<TContext>): [string, ModuleEntry<TContext>] => [entry.name, entry]),
        );
        const path: string[] = [];
        const visited: Map<string, number> = new Map<string, number>();
        let current: string = [...remaining].sort()[0];
        while (!visited.has(current)) {
            visited.set(current, path.length);
            path.push(current);
            const entry: ModuleEntry<TContext> = entriesByName.get(current) as ModuleEntry<TContext>;
            current = entry.after.filter((name: string): boolean => remaining.has(name)).sort()[0];
        }
        // The walk may enter the cycle at any module; the message starts at its alphabetically first one.
        const cycle: string[] = path.slice(visited.get(current) as number);
        const start: number = cycle.indexOf([...cycle].sort()[0]);
        const rotated: string[] = [...cycle.slice(start), ...cycle.slice(0, start)];
        return [...rotated, rotated[0]].join(' -> ');
    }

    private findEntry(target: Function): ModuleEntry<TContext> | undefined {
        return this.entries.find((entry: ModuleEntry<TContext>): boolean => (entry.target as unknown as Function) === target);
    }

    private containerView(): ModuleContainer {
        return {
            register: <T>(service: T, key: string | ContainerKey<T>): void => {
                this.container.register(service, key);
            },
            has: (key: string | ContainerKey<unknown>): boolean => {
                return this.container.has(key);
            },
        };
    }

    private lookupFor(caller: ModuleEntry<TContext>): ModuleLookup {
        return {
            get: <TModule extends object>(target: ContainerKey<TModule>): TModule => {
                const targetEntry: ModuleEntry<TContext> | undefined = this.findEntry(target as unknown as Function);
                if (targetEntry === undefined) {
                    throw new Error(`[ModuleRegistry] Class "${target.name}" is not a registered module`);
                }
                if (!caller.after.includes(targetEntry.name)) {
                    throw new Error(`[ModuleRegistry] Module "${caller.name}" uses "${targetEntry.name}" without listing it in after`);
                }
                if (targetEntry.instance === null) {
                    throw new Error(`[ModuleRegistry] Module "${targetEntry.name}" is not created`);
                }
                return targetEntry.instance as TModule;
            },
        };
    }
}
