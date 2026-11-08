import {ManagedTask, ManagedTaskRegistration} from "../../src/infrastructure/Task/ManagedTask";
import {TaskWorker} from "../../src/infrastructure/Task/TaskWorker";
import {AbstractLogger} from "../../src/types/interfaces/AbstractLogger";

const mockLogger: AbstractLogger = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    notice: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    critical: jest.fn(),
    alert: jest.fn(),
    emergency: jest.fn(),
};

type TaskWorkerFixture = {
    rawWorker: any;
    emitMessage: (message: any) => void;
    emitError: (error: Error) => void;
    emitExit: (code: number | null) => void;
    startCalls: any[][];
};

function createWorkerFixture(): TaskWorkerFixture {
    const listeners: Map<string, ((...args: any[]) => void)[]> = new Map();
    const startCalls: any[][] = [];

    const on = jest.fn((event: string, cb: (...args: any[]) => void): void => {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
    });

    const emit = (event: string, ...args: any[]): void => {
        for (const cb of listeners.get(event) ?? []) {
            cb(...args);
        }
    };

    const rawWorker = {
        on,
        once: on,
        postMessage: jest.fn((message: any): void => {
            if (message?.command === 'start') {
                startCalls.push(message.params);
            }
        }),
        terminate: jest.fn((): Promise<void> => {
            emit('exit', 1);
            return Promise.resolve();
        }),
        threadId: 1,
        performance: undefined,
    };

    return {
        rawWorker,
        emitMessage: (message: any): void => emit('message', message),
        emitError: (error: Error): void => emit('error', error),
        emitExit: (code: number | null): void => emit('exit', code),
        startCalls,
    };
}

function createManagedTask(options: any, spawner: any): ManagedTask {
    return new ManagedTask(
        {name: 'test-task', options, modulePath: '/fake/TestTask.js', className: 'TestTask'},
        mockLogger,
        spawner,
    );
}

describe('ManagedTask', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('dormant task (no schedule, no autostart) spawns no worker on start()', () => {
        const spawner = jest.fn();
        const managed = createManagedTask({name: 'test-task'}, spawner);

        managed.start();

        expect(spawner).not.toHaveBeenCalled();
        expect(managed.getStats().status).toBe('registered');
    });

    test('autostart without schedule dispatches once', () => {
        const spawner = jest.fn((): any => createWorkerFixture().rawWorker);
        const managed = createManagedTask({name: 'test-task', autostart: true}, spawner);

        managed.start();

        expect(spawner).toHaveBeenCalledTimes(1);
        expect(managed.getStats().startedCount).toBe(1);
    });

    test('scheduled task arms timer and dispatches on tick', () => {
        const spawner = jest.fn((): any => createWorkerFixture().rawWorker);
        const managed = createManagedTask({name: 'test-task', schedule: '0 3 * * *'}, spawner);

        managed.start();
        expect(spawner).toHaveBeenCalledTimes(1);
        expect(managed.getStats().nextRunAt).toBeDefined();

        jest.setSystemTime((managed.getStats().nextRunAt as Date).getTime() + 10);
        jest.runOnlyPendingTimers();

        expect(managed.getStats().startedCount).toBe(1);
    });

    test('tick while in flight is counted as skipped', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', schedule: '* * * * *'}, spawner);

        managed.start();

        // First tick: dispatches, worker never reports idle -> stays in flight.
        jest.setSystemTime(Date.now() + 60000);
        jest.runOnlyPendingTimers();
        expect(managed.getStats().startedCount).toBe(1);

        jest.setSystemTime(Date.now() + 120000);
        jest.runOnlyPendingTimers();
        expect(managed.getStats().startedCount).toBe(1);
        expect(managed.getStats().skippedTickCount).toBe(1);
    });

    test('idle event records success, duration and result', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', autostart: true}, spawner);

        managed.start();

        fixture.emitMessage({isRunning: true});
        fixture.emitMessage({result: 42});
        fixture.emitMessage({isRunning: false});

        const stats = managed.getStats();
        expect(stats.successCount).toBe(1);
        expect(stats.lastResult).toBe(42);
        expect(stats.status).toBe('idle');
        expect(stats.lastDurationMs).toBeDefined();
    });

    test('boot-time idle report is not counted as a success', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', schedule: '0 3 * * *'}, spawner);

        managed.start();

        // AbstractTask posts isRunning:false once at worker boot, before any
        // run - this must not inflate successCount.
        fixture.emitMessage({isRunning: false});

        expect(managed.getStats().successCount).toBe(0);
    });

    test('failed run reports error before idle - no phantom success', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', autostart: true}, spawner);

        managed.start();

        // Failed-run message order guaranteed by AbstractTask: error first,
        // then the idle state reset.
        fixture.emitMessage({isRunning: true});
        fixture.emitMessage({error: new Error('task failed')});
        fixture.emitMessage({isRunning: false});

        const stats = managed.getStats();
        expect(stats.successCount).toBe(0);
        expect(stats.errorCount).toBe(1);
        expect(stats.status).toBe('crashed');
    });

    test('a worker error that is not an Error is normalized instead of crashing', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', autostart: true}, spawner);

        managed.start();
        fixture.emitError(null as unknown as Error);

        const stats = managed.getStats();
        expect(stats.errorCount).toBe(1);
        expect(stats.lastError).toBe('null');
        expect(stats.status).toBe('crashed');
    });

    test('falsy payloads reach the stats (0, empty string, false)', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', autostart: true}, spawner);

        managed.start();

        fixture.emitMessage({isRunning: true});
        fixture.emitMessage({message: 0});
        fixture.emitMessage({data: ''});
        fixture.emitMessage({result: false});
        fixture.emitMessage({isRunning: false});

        const stats = managed.getStats();
        expect(stats.lastMessage).toBe(0);
        expect(stats.lastData).toBe('');
        expect(stats.lastResult).toBe(false);
    });

    test('error event marks crashed but the schedule continues (failed run is not a retry)', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', schedule: '* * * * *'}, spawner);

        managed.start();
        expect(managed.getStats().nextRunAt).toBeDefined();

        fixture.emitError(new Error('boom'));

        const stats = managed.getStats();
        expect(stats.errorCount).toBe(1);
        expect(stats.lastError).toBe('boom');
        expect(stats.status).toBe('crashed');
        // Worker still alive - the schedule stays armed for the next occurrence.
        expect(stats.nextRunAt).toBeDefined();

        jest.setSystemTime(Date.now() + 60000);
        jest.runOnlyPendingTimers();
        expect(managed.getStats().startedCount).toBe(1);
    });

    test('unexpected worker exit marks crashed (dead worker = dead schedule)', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', schedule: '* * * * *'}, spawner);

        managed.start();
        fixture.emitExit(137);

        const stats = managed.getStats();
        expect(stats.status).toBe('crashed');
        expect(stats.lastError).toBe('worker exited unexpectedly (code 137)');
        expect(stats.workerExitCode).toBe(137);
    });

    test('exit during stop() maps to stopped, not crashed', async () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', schedule: '* * * * *'}, spawner);

        managed.start();
        const stopping = managed.stop();
        fixture.emitExit(1);
        await stopping;

        expect(managed.getStats().status).toBe('stopped');
        expect(managed.getStats().errorCount).toBe(0);
    });

    test('stop() is idempotent', async () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', autostart: true}, spawner);

        managed.start();
        const first = managed.stop();
        fixture.emitExit(1);
        await first;

        await expect(managed.stop()).resolves.toBeUndefined();
    });

    test('trigger() dispatches manually and honors the in-flight guard', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task'}, spawner);

        managed.trigger();
        managed.trigger();

        expect(managed.getStats().startedCount).toBe(1);
        expect(managed.getStats().skippedTickCount).toBe(1);
    });

    test('rare schedule (delay over setTimeout cap) re-arms via early-wake ticks, no busy loop', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        // Monthly schedule: next occurrence is over 24h away, so every arm
        // hits the MAX_ARM_DELAY_MS cap and wakes into the early-wake branch.
        const managed = createManagedTask({name: 'test-task', schedule: '0 0 1 * *'}, spawner);

        // Mid-month, so the next 1st is weeks away; on the last day of a month it would be under 24h.
        jest.setSystemTime(new Date('2026-10-10T12:00:00Z'));
        managed.start();
        const nextRunAt = managed.getStats().nextRunAt!;
        expect(nextRunAt.getTime() - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000);

        // A full capped day passes: the tick must re-arm (not dispatch, not
        // throw, not fire early).
        jest.advanceTimersByTime(24 * 60 * 60 * 1000);

        expect(managed.getStats().startedCount).toBe(0);
        expect(managed.getStats().nextRunAt?.getTime()).toBe(nextRunAt.getTime());
    });

    test('DST fall-back overlap fires once per wall-clock occurrence', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', schedule: '30 2 * * *'}, spawner);

        // Boot one second before the overlap: 2026-10-25 02:30 Warsaw exists
        // at two UTC instants (00:30 CEST and 01:30 CET).
        jest.setSystemTime(new Date('2026-10-25T00:29:59Z'));
        managed.start();

        jest.setSystemTime(new Date('2026-10-25T00:30:01Z'));
        jest.runOnlyPendingTimers();
        expect(managed.getStats().startedCount).toBe(1);

        // Complete the run so the next tick cannot be skipped by the
        // in-flight guard - only the wall-clock dedup can block it.
        fixture.emitMessage({isRunning: true});
        fixture.emitMessage({isRunning: false});

        // Re-arm after the first instant lands on the SECOND UTC instant of
        // the same wall time (01:30Z = 02:30 CET) - must be deduplicated.
        expect(managed.getStats().nextRunAt?.toISOString()).toBe('2026-10-25T01:30:00.000Z');
        jest.setSystemTime(new Date('2026-10-25T01:30:01Z'));
        jest.runOnlyPendingTimers();

        expect(managed.getStats().startedCount).toBe(1);
        expect(managed.getStats().skippedTickCount).toBe(1);

        // After the overlap the schedule continues on the next day (Warsaw is
        // CET from now on, so 02:30 wall = 01:30Z).
        expect(managed.getStats().nextRunAt?.toISOString()).toBe('2026-10-26T01:30:00.000Z');
    });

    test('trigger() on a crashed scheduled task revives the schedule', () => {
        const fixture = createWorkerFixture();
        const spawner = jest.fn((): any => fixture.rawWorker);
        const managed = createManagedTask({name: 'test-task', schedule: '* * * * *'}, spawner);

        managed.start();
        fixture.emitExit(137);

        expect(managed.getStats().status).toBe('crashed');
        expect(managed.getStats().nextRunAt).toBeUndefined();

        // Manual recovery: fresh worker (spawner called again) AND the cron
        // timer re-armed - a single manual run must not leave the schedule dead.
        managed.trigger();

        expect(spawner).toHaveBeenCalledTimes(2);
        expect(managed.getStats().startedCount).toBe(1);
        expect(managed.getStats().nextRunAt).toBeDefined();
    });
});