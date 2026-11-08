import {parentPort, workerData} from "worker_threads";
import {EventBroadcaster} from "./EventBroadcaster";
import {Serializable} from "../../types/types/Serializable";
import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {Logger} from "@invilite/logger";
import {Console} from "@invilite/logger/Transports";
import {Env} from "../../utils/Env";

type ParentMessage = { command?: string, params: Serializable[] };

/**
 * Base class for tasks executed inside a worker thread. TaskService spawns a
 * worker per task; the worker requires the task's module, instantiates the
 * class and drives it through the command protocol below.
 *
 * The logger is the only dependency provisioned automatically - a Logger
 * instance cannot cross the thread boundary, so it is constructed here, inside
 * the worker, and identified by the task name. Every other dependency (e.g. a
 * database connection) is the task's own responsibility, built in executeTask
 * or the constructor.
 *
 * Task modules must be side-effect-free at import time: TaskService requires
 * them in the parent process during registration.
 */
export abstract class AbstractTask {

    /**
     * Runs the task. Arguments come from the start command (per run); instance
     * configuration belongs in the constructor. All parameters, the return
     * value and sendData payloads must be structured-cloneable.
     */
    public abstract executeTask(...params: Serializable[]): Serializable | Promise<Serializable>;

    public static openEventBroadcaster(channel: string, cb?: (message: Serializable) => void): EventBroadcaster {
        return new EventBroadcaster(channel, cb);
    }

    public static processNameFor(taskName: string, prefix: string | undefined): string {
        return prefix ? `${prefix}: task ${taskName}` : `task ${taskName}`;
    }

    protected readonly logger: AbstractLogger;

    private readonly taskName: string;

    protected constructor() {
        this.taskName = (workerData?.taskName as string) ?? 'unknown';
        this.logger = new Logger({processName: AbstractTask.processNameFor(this.taskName, workerData?.processNamePrefix)})
            .addTransport(new Console(
                (Env.getString('NODE_ENV', 'development') === 'production') ? 6 : 8,
                0,
            ));

        this.initializeWorker();
    }

    protected getTaskName(): string {
        return this.taskName;
    }

    protected sendMessage(message: Serializable): void {
        parentPort?.postMessage({
            message,
        });
    }

    protected sendData(data: Serializable): void {
        parentPort?.postMessage({
            data,
        });
    }

    protected sendError(error: unknown): void {
        parentPort?.postMessage({
            error: error instanceof Error ? error : new Error(String(error)),
        });
    }

    private updateState(isRunning: boolean): void {
        parentPort?.postMessage({
            isRunning,
        });
    }

    private updateLastResult(result: Serializable): void {
        parentPort?.postMessage({
            result,
        });
    }

    // Registering the parentPort listener in the constructor is safe: worker
    // messages cannot be delivered before the synchronous boot (module require
    // + constructor chain, including subclass field initializers) completes.
    // No initial state report is sent on purpose: isRunning messages describe
    // runs only, and a boot-time "idle" would be mistaken for a completed run
    // by parent-side accounting.
    private initializeWorker(): void {
        parentPort?.on('message', (message: ParentMessage): void => {
            if (message?.command) {
                try {
                    this.executeCommand(message.command, message.params);
                } catch (error) {
                    this.sendError(error as Error);
                    process.exit(-1);
                }
            }
        });
    }

    private executeCommand(command: string, params: Serializable[]): void {
        switch (command) {
            case 'start':
                this.startTask(params).catch((error: Error): void => {
                    this.sendError(error);
                });
                break;

            case 'terminate':
                process.exit(0);
        }
    }

    private async startTask(params: Serializable[]): Promise<void> {
        this.updateState(true);
        try {
            const result: Serializable | Promise<Serializable> = this.executeTask(...params);
            this.updateLastResult(result instanceof Promise ? await result : result);
        } catch (error) {
            // Report the failure BEFORE the idle state below, so the parent
            // sees error -> idle and cannot mistake the run for a success.
            this.sendError(error as Error);
        } finally {
            // The idle report must fire on every path - a rejected run that
            // left the state at "running" would permanently brick the worker
            // (every later start command would be silently ignored).
            this.updateState(false);
        }
    }
}