import {TaskWorker} from "./TaskWorker";
import {CronExpression} from "../../utils/CronExpression";
import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {Serializable} from "../../types/types/Serializable";
import {TaskOptions, TaskStats, createTaskStats} from "../../types/types/TaskTypes";

export type ManagedTaskRegistration = {
    name: string;
    options: TaskOptions;
    modulePath: string;
    className: string;
};

export type WorkerSpawner = (registration: ManagedTaskRegistration) => import("worker_threads").Worker;

/**
 * Parent-side owner of one managed task: worker lifecycle, cron timer,
 * overlap guard and live statistics. Scheduling is deliberately a parent
 * concern - the worker thread stays a dumb executor.
 *
 * Semantics:
 * - Overlapping ticks are structurally impossible: a tick while a run is
 *   in flight is counted as skipped, never silently dropped.
 * - A dead worker means a dead schedule: an unexpected exit clears the timer
 *   and marks the task crashed. There is no automatic re-creation - recovery
 *   is a process restart or an explicit TaskService.startTask() call.
 * - DST fall-back overlap fires once per wall-clock occurrence (the same wall
 *   time maps to two UTC instants); a wall-clock key of the scheduled run
 *   deduplicates this.
 */
export class ManagedTask {
    // Node clamps setTimeout delays above 2^31-1 ms (~24.8 days) to 1 ms;
    // capping the arm delay keeps rare (monthly/yearly) schedules safe.
    private static readonly MAX_ARM_DELAY_MS = 24 * 60 * 60 * 1000;

    private readonly registration: ManagedTaskRegistration;
    private readonly logger: AbstractLogger;
    private readonly spawner: WorkerSpawner;

    private cron: CronExpression | null = null;
    private timer: NodeJS.Timeout | null = null;
    // Occurrence the timer is armed for. Kept beside the timer (not read from
    // stats.nextRunAt) because stats are a mutable monitoring projection.
    private armedFor: Date | null = null;
    private worker: TaskWorker | null = null;
    private inFlight: boolean = false;
    private stopping: boolean = false;
    private lastFiredWallClockKey: string | null = null;

    private readonly stats: TaskStats;

    public constructor(registration: ManagedTaskRegistration, logger: AbstractLogger, spawner: WorkerSpawner, stats?: TaskStats) {
        this.registration = registration;
        this.logger = logger;
        this.spawner = spawner;
        this.stats = stats ?? createTaskStats();

        if (this.registration.options.schedule !== undefined) {
            this.cron = CronExpression.parse(this.registration.options.schedule, this.registration.options.timeZone);
        }
    }

    public start(): void {
        if (this.timer !== null || this.worker !== null) {
            return;
        }

        this.stopping = false;

        if (this.cron !== null) {
            this.stats.status = 'idle';
            this.ensureWorker();
            this.armSchedule(new Date());
            this.logger.trace(`[TaskService] Scheduled task "${this.registration.name}" (${this.registration.options.schedule}).`);
        } else if (this.registration.options.autostart === true) {
            this.ensureWorker();
            this.dispatch([], null);
            this.logger.trace(`[TaskService] Autostart task "${this.registration.name}" dispatched.`);
        }
    }

    public stop(): Promise<void> {
        this.stopping = true;
        this.clearTimer();

        const worker: TaskWorker | null = this.worker;
        if (worker === null || worker.isTerminated()) {
            this.stats.status = 'stopped';
            return Promise.resolve();
        }

        return new Promise<void>((resolve): void => {
            worker.once('exit', (): void => resolve());
            worker.terminate((exitCode?: number, error?: Error): void => {
                if (error !== undefined) {
                    this.logger.warning(`[TaskService] Error terminating task "${this.registration.name}": ${error.message}`);
                }
            });
        });
    }

    /**
     * Manual dispatch. Lazily spawns the worker; honors the in-flight guard.
     * Also the documented recovery path: for a crashed scheduled task this
     * re-arms the schedule (a fresh worker alone would leave it dead) and runs
     * once immediately. Manual runs bypass the wall-clock dedup (it applies to
     * cron occurrences only) and never clear the recorded dedup key.
     */
    public trigger(params: Serializable[] = []): void {
        if (this.stopping) {
            return;
        }

        if (this.cron !== null && this.timer === null) {
            this.armSchedule(new Date());
        }

        this.ensureWorker();
        this.dispatch(params, null);
    }

    public getName(): string {
        return this.registration.name;
    }

    public getStats(): TaskStats {
        return this.stats;
    }

    private ensureWorker(): void {
        if (this.worker !== null && !this.worker.isTerminated()) {
            return;
        }

        const worker: TaskWorker = new TaskWorker(this.spawner(this.registration));
        this.worker = worker;
        this.wireWorkerEvents(worker);
    }

    private wireWorkerEvents(worker: TaskWorker): void {
        worker.on('running', (): void => {
            this.stats.status = 'running';
        });

        worker.on('idle', (lastResult: Serializable | undefined): void => {
            // Idle without a dispatched run is either the worker's boot report
            // or the state reset following a reported error - neither is a
            // success. Without this guard a rejected run (error -> idle) and
            // the boot report would both inflate successCount.
            if (!this.inFlight) {
                return;
            }

            this.inFlight = false;
            this.stats.successCount++;
            this.stats.lastResult = lastResult;
            this.stats.lastFinishedAt = new Date();
            if (this.stats.lastStartedAt !== undefined) {
                this.stats.lastDurationMs = this.stats.lastFinishedAt.getTime() - this.stats.lastStartedAt.getTime();
            }
            this.stats.status = 'idle';
            this.recomputeNextRun();
        });

        worker.on('message', (message: Serializable): void => {
            this.stats.lastMessage = message;
        });

        worker.on('data', (data: Serializable): void => {
            this.stats.lastData = data;
        });

        worker.on('error', (error: unknown): void => {
            // A failed run is recorded but does NOT kill the schedule - the
            // worker thread is still alive, and the next cron occurrence is a
            // fresh run, not a retry. Only a dead worker (exit) kills the
            // schedule.
            const normalized: Error = error instanceof Error ? error : new Error(String(error));
            this.inFlight = false;
            this.stats.errorCount++;
            this.stats.lastError = normalized.message;
            this.stats.lastErrorStack = normalized.stack;
            this.stats.status = 'crashed';
        });

        worker.on('exit', (code: number | null): void => {
            this.inFlight = false;

            if (this.stopping) {
                this.stats.status = 'stopped';
            } else if (this.stats.status !== 'crashed') {
                this.stats.errorCount++;
                this.stats.lastError = `worker exited unexpectedly (code ${code})`;
                this.stats.status = 'crashed';
            }

            this.stats.workerExitCode = code;
            this.worker = null;
            this.clearTimer();
            delete this.stats.nextRunAt;
        });
    }

    private dispatch(params: Serializable[], wallClockKey: string | null): void {
        if (this.inFlight) {
            this.stats.skippedTickCount++;
            this.logger.warning(`[TaskService] Task "${this.registration.name}" is still running - tick skipped.`);
            return;
        }

        if (wallClockKey !== null && wallClockKey === this.lastFiredWallClockKey) {
            // DST fall-back: the same wall time occurs at two UTC instants.
            this.stats.skippedTickCount++;
            return;
        }

        this.inFlight = true;
        // Manual runs (null key) must not clear the recorded cron dedup key -
        // doing so would let the overlap's second instant fire again.
        if (wallClockKey !== null) {
            this.lastFiredWallClockKey = wallClockKey;
        }
        this.stats.startedCount++;
        this.stats.lastStartedAt = new Date();
        this.ensureWorker();
        this.worker!.start(...params);
    }

    private armSchedule(from: Date): void {
        if (this.cron === null || this.stopping) {
            return;
        }

        const nextRun: Date | null = this.cron.next(from);
        if (nextRun === null) {
            this.logger.warning(`[TaskService] Task "${this.registration.name}" has no upcoming cron occurrence within the horizon.`);
            return;
        }

        this.stats.nextRunAt = nextRun;
        this.armedFor = nextRun;

        // setTimeout overflows (and Node clamps the delay to 1 ms) above
        // 2^31-1 ms (~24.8 days), which would busy-loop monthly/yearly
        // schedules. Cap the arm delay; the early-wake branch in onTick()
        // re-arms until the occurrence is actually due.
        const delay: number = Math.min(
            Math.max(nextRun.getTime() - Date.now(), 0),
            ManagedTask.MAX_ARM_DELAY_MS,
        );

        // Self-re-arming timeout (never setInterval) so a tick can never
        // overlap the previous run; unref'd so a pending timer can never keep
        // the process alive on the stop path.
        this.timer = setTimeout((): void => {
            this.timer = null;
            this.onTick();
        }, delay);
        this.timer.unref();
    }

    private onTick(): void {
        if (this.stopping) {
            return;
        }

        // Timer fired while the armed occurrence is still in the future:
        // either a capped arm delay (schedule further out than MAX_ARM_DELAY_MS)
        // or a clock stepped back. Re-arm and wait - never fire early.
        if (this.armedFor !== null && this.armedFor.getTime() > Date.now() + 1000) {
            this.armSchedule(new Date());
            return;
        }

        const wallClockKey: string | null = (this.cron !== null && this.armedFor !== null)
            ? this.cron.wallClockKey(this.armedFor)
            : null;

        this.dispatch([], wallClockKey);
        this.armSchedule(new Date());
    }

    private recomputeNextRun(): void {
        if (this.cron === null) {
            delete this.stats.nextRunAt;
            return;
        }

        const next: Date | null = this.cron.next(new Date());
        if (next !== null) {
            this.stats.nextRunAt = next;
        } else {
            delete this.stats.nextRunAt;
        }
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.armedFor = null;
    }
}