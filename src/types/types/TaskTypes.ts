import {Serializable} from "./Serializable";

export interface TaskServiceOptions {
    processNamePrefix?: string;
}

export type TaskOptions = {
    name: string;
    schedule?: string;
    timeZone?: string;
    autostart?: boolean;
};

export type TaskStatus = 'registered' | 'idle' | 'running' | 'crashed' | 'stopped';

export type TaskStats = {
    status: TaskStatus;
    lastResult?: Serializable;
    lastMessage?: Serializable;
    lastData?: Serializable;
    lastError?: string;
    lastErrorStack?: string;
    startedCount: number;
    successCount: number;
    errorCount: number;
    skippedTickCount: number;
    lastStartedAt?: Date;
    lastFinishedAt?: Date;
    lastDurationMs?: number;
    nextRunAt?: Date;
    workerExitCode?: number | null;
};

export type TaskRegistration = {
    name: string;
    options: TaskOptions;
    modulePath: string;
    className: string;
    stats: TaskStats;
};

export function createTaskStats(): TaskStats {
    return {
        status: 'registered',
        startedCount: 0,
        successCount: 0,
        errorCount: 0,
        skippedTickCount: 0,
        workerExitCode: null,
    };
}