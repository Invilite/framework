import 'reflect-metadata';
// @ts-ignore
import fs from "fs";
import {Worker} from "worker_threads";
import {TaskService} from "../../src/services/TaskService";
import {AbstractLogger} from "../../src/types/interfaces/AbstractLogger";
import {AbstractTask} from "../../src/infrastructure/Task/AbstractTask";

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

const workerStub = {
    threadId: 1,
    on: jest.fn(),
    once: jest.fn(),
};

jest.mock('fs');

jest.mock('worker_threads', () => ({
    Worker: jest.fn(),
}));

jest.mock('/tasks/SimpleTask.js', () => ({
    SimpleTask: class SimpleTask {},
}), { virtual: true });

jest.mock('../../src/utils', () => ({
    Class: {
        isInheritedFrom: jest.fn(),
    },
    Path: {
        resolve: jest.fn().mockImplementation((...args) => args.join('/')),
    },
}));

describe('TaskService worker data', () => {
    beforeEach(() => {
        (Worker as unknown as jest.Mock).mockImplementation((): typeof workerStub => workerStub);

        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.readdirSync as jest.Mock).mockReturnValue(['SimpleTask.js']);

        jest.spyOn(Reflect, 'getMetadata').mockImplementation((metadataKey: string, target: unknown) => {
            const taskClass: {name?: string} = target as {name?: string};
            if (metadataKey === 'TaskName' && taskClass.name === 'SimpleTask') {
                return 'simple';
            }
            if (metadataKey === 'IsWorker' && taskClass.name === 'SimpleTask') {
                return true;
            }
            return undefined;
        });

        const {Class} = require('../../src/utils');
        (Class.isInheritedFrom as jest.Mock).mockReturnValue(true);
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    test('passes the configured process name prefix to the worker', (): void => {
        const taskService: TaskService = new TaskService(mockLogger, ['/tasks'], {processNamePrefix: 'app'});
        taskService.createTask('simple');

        expect(Worker).toHaveBeenCalledTimes(1);
        expect(Worker).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            name: 'simple',
            workerData: {
                modulePath: '/tasks/SimpleTask.js',
                className: 'SimpleTask',
                params: [],
                taskName: 'simple',
                processNamePrefix: 'app',
            },
        }));
    });

    test('leaves the process name prefix undefined without options', (): void => {
        const taskService: TaskService = new TaskService(mockLogger, ['/tasks']);
        taskService.createTask('simple');

        const workerOptions: {workerData: {processNamePrefix?: string}} =
            (Worker as unknown as jest.Mock).mock.calls[0][1];
        expect(workerOptions.workerData.processNamePrefix).toBeUndefined();
    });

    test('passes the module path and class name as worker data and resolves a default export', (): void => {
        (fs.readdirSync as jest.Mock).mockReturnValue(['DefaultTask.js']);

        class DefaultTask extends AbstractTask {
            public executeTask(): null {
                return null;
            }
        }

        jest.mock('/tasks/DefaultTask.js', () => ({default: DefaultTask}), {virtual: true});

        jest.spyOn(Reflect, 'getMetadata').mockImplementation((metadataKey: string, target: unknown) => {
            if (target === DefaultTask && metadataKey === 'TaskName') {
                return 'default-task';
            }
            if (target === DefaultTask && metadataKey === 'IsWorker') {
                return true;
            }
            return undefined;
        });

        const {Class, Path} = require('../../src/utils');
        (Class.isInheritedFrom as jest.Mock).mockImplementation((target: unknown) => target === DefaultTask);
        (Path.resolve as jest.Mock).mockImplementation((...args: string[]) => args.join('/'));

        const taskService: TaskService = new TaskService(mockLogger, ['/tasks']);
        expect(taskService.getRegistrations().get('default-task')?.className).toBe('default');

        taskService.createTask('default-task');

        const workerCode: string = (Worker as unknown as jest.Mock).mock.calls[0][0];
        const workerOptions: {workerData: {modulePath: string; className: string}} =
            (Worker as unknown as jest.Mock).mock.calls[0][1];

        expect(workerCode).not.toContain('/tasks/DefaultTask.js');
        expect(workerCode).toContain('workerData.modulePath');
        expect(workerOptions.workerData).toEqual(expect.objectContaining({
            modulePath: '/tasks/DefaultTask.js',
            className: 'default',
        }));
    });
});
