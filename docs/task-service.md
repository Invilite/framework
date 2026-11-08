# Task service: worker threads with a cron schedule

TaskService runs task classes in separate worker threads (`worker_threads`), with a cron schedule, live statistics and lifecycle control. It fits cleanup, reindexing and other heavier or repetitive jobs that must not block the HTTP server.

- Sources: `src/services/TaskService.ts`, `src/infrastructure/Task/` (`AbstractTask`, `TaskWorker`, `ManagedTask`), `src/utils/CronExpression.ts`
- Implementation traps: `REVIEW.md`

## 1. Writing a task class

The file must be named `*Task.ts` (the scan filters by suffix). Put it in any directory you pass to the `TaskService` constructor; the scan is recursive. If you organize the application into domains, `Domains` (`src/infrastructure/Filesystem/Domains.ts`) reports the `tasks` subdirectory of every domain as `tasksPath`.

```ts
// tasks/CleanupSessionsTask.ts
import pg from "pg";
import {Task} from "@invilite/framework/decorators/Task/Task";
import {AbstractTask} from "@invilite/framework/infrastructure/Task/AbstractTask";
import {Serializable} from "@invilite/framework/types/types/Serializable";

@Task({
    name: "cleanup-sessions",     // unique registry name (required)
    schedule: "*/30 * * * *",     // 5-field cron; missing = manual-only task
    timeZone: "Europe/Warsaw",    // optional, this is the default
    autostart: true,              // see the semantics table below
})
export class CleanupSessionsTask extends AbstractTask {

    public async executeTask(olderThanDays: number): Promise<Serializable> {
        // this.logger is the ONLY dependency provided automatically
        // (process name "my-app: task cleanup-sessions" when the service
        // was built with processNamePrefix: "my-app")
        this.logger.info("Starting session cleanup");

        // Build connections yourself: the parent process's PgClient pool
        // cannot cross the thread boundary
        const client: pg.Client = new pg.Client({connectionString: process.env.DATABASE_URL});
        await client.connect();
        try {
            const result: pg.QueryResult = await client.query(
                "DELETE FROM sessions WHERE created_at < NOW() - make_interval(days => $1)",
                [olderThanDays],
            );
            const deleted: number = result.rowCount ?? 0;
            this.sendMessage(`deleted ${deleted}`);  // progress -> statistics
            return {deleted};                       // run result -> lastResult
        } finally {
            await client.end();
        }
    }
}
```

The worker's process name comes from `AbstractTask.processNameFor(taskName, prefix)`: `<prefix>: task <name>` when the application passes `processNamePrefix` in the `TaskService` options, `task <name>` without one.

Class constraints:

- the module must be free of import-time side effects: the scan does `require` in the main process, so open connections in the constructor or `executeTask`, never at module level,
- everything that crosses the thread boundary (parameters, the return value, `sendData` payloads) must be structured-cloneable (plain data, not class instances),
- the worker lives between runs, so one-time initialization (for example a connection) can go in the constructor and stay on a field.

Registration requires both the `@Task` decorator and extending `AbstractTask`. A class without a name, or with a name already registered, is logged and skipped; a missing tasks directory logs a warning.

## 2. Decorator options: what runs when

| Configuration | Behaviour at start |
|---|---|
| `schedule` | cron timer armed immediately (`autostart` unnecessary) |
| `autostart: true` without `schedule` | one run at start |
| neither | dormant: zero threads, a registry entry only, started manually |

The short form `@Task("name")` still works and means a dormant task.

## 3. Cron format

Five fields: `minute hour day-of-month month day-of-week`.

- lists `1,15`, ranges `8-12`, steps `*/15` and `10-40/5`,
- `0` and `7` both mean Sunday; when day-of-month and day-of-week are both restricted they combine with OR (vixie-cron),
- time zone `Europe/Warsaw` by default, with full DST semantics: a spring-gap occurrence is skipped, a fall-back overlap fires once (deduplicated by wall-clock time).

## 4. Error semantics

- Failed run (`executeTask` throws or rejects): `errorCount++`, status `crashed`, but the schedule stays alive. The next cron tick is a fresh occurrence, not a retry.
- Thread death (worker exit): status `crashed`, the schedule is dead, there is no automatic re-creation. Recovery is a process restart or a manual `startTask` (below).
- A tick while a run is still in flight (task longer than the interval) is skipped and counted in `skippedTickCount`; runs never overlap.

## 5. Manual start and recovery

```ts
const taskService: TaskService = new TaskService(logger, [tasksDirectory], {processNamePrefix: "my-app"});
taskService.startTask("cleanup-sessions");       // runs now, reusing the live worker
taskService.startTask("cleanup-sessions", [30]); // second argument = executeTask parameters
```

`startTask` dispatches a run on the task's worker, spawning one only when none is alive, and arms the cron timer only when it is empty (a crashed scheduled task is exactly that state, because the worker exit clears it). A live worker and an armed schedule are therefore reused, while for a crashed task `startTask` is the recovery path: a fresh worker, a re-armed timer and an immediate run. An unknown name throws.

## 6. Monitoring

```ts
const registrations: Map<string, TaskRegistration> = taskService.getRegistrations();
const stats: TaskStats = registrations.get("cleanup-sessions")!.stats;
// stats.status: 'registered' | 'idle' | 'running' | 'crashed' | 'stopped'
// counters: startedCount, successCount, errorCount, skippedTickCount
// last values: lastResult, lastMessage, lastData, lastError, lastDurationMs
// timing: nextRunAt, lastStartedAt, lastFinishedAt, workerExitCode
```

The `stats` object is live (mutated in place): a held reference always shows the current state. There is deliberately no HTTP or UI reader on top; the in-memory registry is the seam for a future one.

## 7. Full control without the registry (escape hatch)

```ts
const worker: TaskWorker = taskService.createTask("cleanup-sessions", [constructorArgument]);
worker.on("message", (message: Serializable): void => {/* ... */}); // also: running / idle / data / error / exit
worker.start(30);    // arguments go to executeTask; createTask's went to the constructor
worker.terminate();  // lifecycle fully owned by the caller
```

Note: two quick `start()` calls can both pass the internal guard (the running confirmation comes back asynchronously from the thread), so serialize dispatches yourself. Managed (registry) tasks have their own synchronous in-flight guard.

## 8. Lifecycle: what happens by itself

- Construction scans the task directories and registers classes; no worker is spawned until `start()` or `startTask()`. `start()` arms the schedules, runs autostart tasks once and leaves the rest dormant.
- Shutdown: call `await taskService.stop()` before closing database pools or message brokers. It clears the timers and terminates the workers idempotently; the resulting status is `stopped`, not `crashed`. Connections the task opened close in `executeTask` or its `finally`.
- An invalid cron in the decorator is an error logged at registration; the task is skipped and the boot continues.
