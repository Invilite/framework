import 'reflect-metadata';
import fs from "fs";
import {Worker} from 'worker_threads';
import {TaskWorker} from "../infrastructure/Task/TaskWorker";
import {AbstractTask} from "../infrastructure/Task/AbstractTask";
import {AbstractLogger} from "../types/interfaces/AbstractLogger";
import {ManagedTask, ManagedTaskRegistration} from "../infrastructure/Task/ManagedTask";
import {Class, Path} from "../utils";
import {CronExpression} from "../utils/CronExpression";
import {Serializable} from "../types/types/Serializable";
import {
    METADATA_IS_WORKER,
    METADATA_TASK_AUTOSTART,
    METADATA_TASK_NAME,
    METADATA_TASK_SCHEDULE,
    TaskScheduleMetadata,
} from "../decorators/Task/Task";
import {TaskOptions, TaskRegistration, TaskServiceOptions, createTaskStats} from "../types/types/TaskTypes";

export class TaskService {
    private readonly registrations: Map<string, TaskRegistration>;
    private readonly managedTasks: Map<string, ManagedTask>;

    /**
     * Scans the given directories and registers task classes. Pure
     * registration - no workers are spawned until start() or startTask().
     * A missing directory logs a warning instead of crashing the bootstrap.
     */
    public constructor(
        protected readonly logger: AbstractLogger,
        tasksPaths: string[],
        private readonly options: TaskServiceOptions = {},
    ) {
        this.registrations = new Map<string, TaskRegistration>();
        this.managedTasks = new Map<string, ManagedTask>();
        this.registerTasks(tasksPaths);
    }

    /**
     * Starts all managed tasks: scheduled tasks get their cron timer armed,
     * autostart tasks without a schedule run once, the rest stay dormant
     * (no worker spawned) until an explicit startTask() call.
     */
    public start(): void {
        for (const [name, registration] of this.registrations) {
            const managed: ManagedTask = this.getOrCreateManagedTask(name, registration);
            managed.start();
        }
    }

    /** Stops every managed task (schedules + workers). Idempotent. */
    public async stop(): Promise<void> {
        const stopping: Promise<void>[] = [];
        for (const managed of this.managedTasks.values()) {
            stopping.push(managed.stop());
        }
        await Promise.allSettled(stopping);
    }

    /**
     * Manual trigger of a managed task. Lazily spawns its worker; unknown
     * names throw. Also the recovery path for a crashed task.
     */
    public startTask(name: string, params: Serializable[] = []): void {
        const registration: TaskRegistration | undefined = this.registrations.get(name);
        if (!registration) {
            throw new Error(`Task "${name}" is not a registered task`);
        }

        this.getOrCreateManagedTask(name, registration).trigger(params);
    }

    /**
     * Ad-hoc, unmanaged task run outside the registry lifecycle. The caller
     * owns the returned TaskWorker (events, terminate). Constructor arguments
     * of the task class are passed here; run arguments go to start().
     */
    public createTask(taskName: string, constructorParams?: Serializable[]): TaskWorker {
        const task: TaskRegistration | undefined = this.registrations.get(taskName);
        if (!task) {
            throw new Error(`Task "${taskName} is not a registered task"`);
        }

        return new TaskWorker(this.startWorker(taskName, constructorParams));
    }

    public getRegistrations(): Map<string, TaskRegistration> {
        return this.registrations;
    }

    private getOrCreateManagedTask(name: string, registration: TaskRegistration): ManagedTask {
        let managed: ManagedTask | undefined = this.managedTasks.get(name);
        if (managed === undefined) {
            const managedRegistration: ManagedTaskRegistration = {
                name: registration.name,
                options: registration.options,
                modulePath: registration.modulePath,
                className: registration.className,
            };
            // The registry entry and the ManagedTask share one stats object,
            // so getRegistrations() always reflects live state.
            managed = new ManagedTask(
                managedRegistration,
                this.logger,
                (taskRegistration: ManagedTaskRegistration): Worker => this.startWorker(taskRegistration.name, []),
                registration.stats,
            );
            this.managedTasks.set(name, managed);
        }

        return managed;
    }

    private startWorker(taskName: string, constructorParams?: Serializable[]): Worker {
        const task: TaskRegistration | undefined = this.registrations.get(taskName);
        if (!task) {
            throw new Error(`Task "${taskName}" is not a registered task`);
        }

        const workerCode: string = `
            const {workerData} = require('worker_threads');
            const taskModule = require(workerData.modulePath);
            const TaskClass = taskModule[workerData.className];
            const task = new TaskClass(...workerData.params);
        `;

        return new Worker(workerCode, {
            eval: true,
            name: taskName,
            workerData: {
                modulePath: task.modulePath,
                className: task.className,
                params: constructorParams ?? [],
                taskName: taskName,
                processNamePrefix: this.options.processNamePrefix,
            },
        });
    }

    private registerTasks(tasksPaths: string[]): void {
        for (const tasksPath of tasksPaths) {
            this.registerTasksFromPath(tasksPath);
        }
    }

    private registerTasksFromPath(tasksPath: string): void {
        const basePath: string = Path.resolve(tasksPath);

        if (!fs.existsSync(basePath)) {
            this.logger.warning(`Tasks directory "${basePath}" does not exist - skipping.`);
            return;
        }

        this.logger.trace(`Searching for tasks in "${basePath}" ...`);
        const taskFiles: string[] = fs.readdirSync(basePath, {encoding: 'utf8', recursive: true})
            .filter((taskFile: string): boolean => taskFile.endsWith("Task.js") || taskFile.endsWith("Task.ts"));

        for (const taskFile of taskFiles) {
            try {
                const modulePath: string = Path.resolve(basePath, taskFile);
                const module = require(modulePath);
                const modulePropertyNames: string[] = Object.keys(module);

                for (const className of modulePropertyNames) {
                    const target: unknown = module[className];

                    if (typeof target !== 'function') {
                        continue;
                    }

                    const isWorker: boolean = Reflect.getMetadata(METADATA_IS_WORKER, target) || false;

                    if (!isWorker) {
                        this.logger.trace(`Bypassing class "${className}" because it's not a worker (missing decorator)`);
                        continue;
                    }

                    if (!Class.isInheritedFrom(target as new (...args: unknown[]) => object, AbstractTask)) {
                        this.logger.trace(`Bypassing class "${className}" as it doesn't extend AbstractTask`);
                        continue;
                    }

                    const taskName: string = Reflect.getMetadata(METADATA_TASK_NAME, target) || "";
                    if (!taskName) {
                        this.logger.warning(`Task name missing for class "${className}" in file "${taskFile}"`);
                        continue;
                    }

                    if (this.registrations.has(taskName)) {
                        const existing: TaskRegistration = this.registrations.get(taskName)!;
                        this.logger.warning(`Class "${className}" cannot be registered as "${taskName}" because task with that name already exists (${existing.className} in ${existing.modulePath}).`);
                        continue;
                    }

                    const scheduleMetadata: TaskScheduleMetadata | undefined = Reflect.getMetadata(METADATA_TASK_SCHEDULE, target) as TaskScheduleMetadata | undefined;
                    const autostart: boolean = Reflect.getMetadata(METADATA_TASK_AUTOSTART, target) === true;

                    const options: TaskOptions = {name: taskName};
                    if (scheduleMetadata !== undefined) {
                        options.schedule = scheduleMetadata.cron;
                        if (scheduleMetadata.timeZone !== undefined) {
                            options.timeZone = scheduleMetadata.timeZone;
                        }
                    }
                    options.autostart = autostart;

                    // Validate at registration: an invalid cron must not take
                    // the whole bootstrap down when start() parses it later.
                    if (options.schedule !== undefined) {
                        try {
                            CronExpression.parse(options.schedule, options.timeZone);
                        } catch (error) {
                            this.logger.error(`Task "${taskName}" (${taskFile}) has an invalid schedule "${options.schedule}": ${(error as Error).message} - task skipped.`);
                            continue;
                        }
                    }

                    this.logger.trace(`Registering class "${className}" as "${taskName}" task ...`);
                    this.registrations.set(taskName, {
                        name: taskName,
                        options,
                        modulePath,
                        className,
                        stats: createTaskStats(),
                    });
                }
            } catch (e) {
                this.logger.error(`Error while registering task from file ${taskFile}:`, e);
            }
        }
    }
}