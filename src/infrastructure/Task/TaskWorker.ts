import EventEmitter from "events";
import type {EventLoopUtilization} from "node:perf_hooks";
import {Worker} from 'worker_threads';
import {Serializable} from "../../types/types/Serializable";

// Messages from the worker thread. Dispatch uses 'key' in message checks (not
// truthiness) so falsy payloads (0, '', false, null) are never dropped.
export type TaskWorkerMessage =
    | { isRunning: boolean }
    | { message: Serializable }
    | { data: Serializable }
    | { result: Serializable }
    | { error: Error };

type TaskWorkerCommand = { command: 'start', params: Serializable[] };

type TerminateCallback = (exitCode?: number, error?: Error) => void;

export class TaskWorker extends EventEmitter {
    protected lastResult: Serializable | undefined;
    protected workerRunning: boolean = false;
    protected workerTerminated: boolean = false;

    public constructor(protected readonly worker: Worker) {
        super();
        this.workerRunning = false;
        this.workerTerminated = (worker.threadId === null);

        worker.on('error', (error: Error) => {
            this.emit('error', error);
        });

        worker.once('exit', (code: number | null) => {
            this.workerTerminated = true;
            this.emit('exit', code);
        });

        worker.on('message', (message: TaskWorkerMessage): void => this.handleMessage(message));
    }

    // NOTE for unmanaged (createTask) consumers: workerRunning is confirmed by
    // a message from the thread, so two start() calls within the same tick can
    // both pass the guard and enqueue two runs. Managed tasks are protected by
    // ManagedTask's synchronous inFlight guard; raw TaskWorker callers must
    // serialize their own dispatches.
    public start(...params: Serializable[]): void {
        if (!this.isAlive()) {
            this.emit('error', new Error("Task cannot be started because the process has terminated its execution."));
        } else if (!this.workerRunning) {
            const command: TaskWorkerCommand = {command: 'start', params};
            this.worker.postMessage(command);
        }
    }

    public terminate(cb?: TerminateCallback): void {
        if (this.isAlive()) {
            this.worker.terminate().then(cb).catch((error: Error): void => this.reportTerminateError(error, cb));
        } else {
            this.reportTerminateError(new Error("Worker is already terminated."), cb);
        }
    }

    public isRunning(): boolean {
        return this.workerRunning;
    }

    public isTerminated(): boolean {
        return this.workerTerminated;
    }

    public getEventLoopUtilization(): EventLoopUtilization | null {
        if (this.worker.performance) {
            return this.worker.performance.eventLoopUtilization();
        }
        return null;
    }

    private isAlive(): boolean {
        return !this.workerTerminated && this.worker.threadId !== null;
    }

    private reportTerminateError(error: Error, cb?: TerminateCallback): void {
        if (cb) {
            cb(undefined, error);
        } else {
            this.emit('error', error);
        }
    }

    private handleMessage(message: TaskWorkerMessage): void {
        if ('isRunning' in message && typeof message.isRunning === "boolean") {
            this.workerRunning = message.isRunning;
            if (message.isRunning) {
                this.emit('running');
            } else {
                this.emit('idle', this.lastResult);
            }
        } else if ('error' in message) {
            this.emit('error', message.error instanceof Error ? message.error : new Error(String(message.error)));
        } else if ('result' in message) {
            this.lastResult = message.result;
        } else if ('data' in message) {
            this.emit('data', message.data);
        } else if ('message' in message) {
            this.emit('message', message.message);
        }
    }
}
