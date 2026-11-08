import 'reflect-metadata';
import {TaskOptions} from "../../types/types/TaskTypes";

export const METADATA_IS_WORKER: string = 'IsWorker';
export const METADATA_TASK_NAME: string = 'TaskName';
export const METADATA_TASK_SCHEDULE: string = 'TaskSchedule';
export const METADATA_TASK_AUTOSTART: string = 'TaskAutostart';

export type TaskScheduleMetadata = { cron: string; timeZone: string };

/**
 * Class decorator marking a class as a TaskService task. The class must extend
 * AbstractTask to be registered.
 *
 * @example @Task('foo')
 * @example @Task({name: 'cleanup', schedule: '0 3 * * *', autostart: true})
 */
export const Task: (options: string | TaskOptions) => ClassDecorator = (options: string | TaskOptions): ClassDecorator => {
    const resolved: TaskOptions = (typeof options === 'string') ? {name: options} : options;

    return (target: any): void => {
        Reflect.defineMetadata(METADATA_IS_WORKER, true, target);
        Reflect.defineMetadata(METADATA_TASK_NAME, resolved.name, target);

        if (resolved.schedule !== undefined) {
            Reflect.defineMetadata(METADATA_TASK_SCHEDULE, {
                cron: resolved.schedule,
                timeZone: resolved.timeZone,
            }, target);
        }

        if (resolved.autostart !== undefined) {
            Reflect.defineMetadata(METADATA_TASK_AUTOSTART, resolved.autostart, target);
        }
    };
};