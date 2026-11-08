import 'reflect-metadata';
// @ts-ignore
import fs from "fs";
import {TaskService} from "../../src/services/TaskService";
import {AbstractLogger} from "../../src/types/interfaces/AbstractLogger";
import {Class, Path} from "../../src/utils";
import {AbstractTask} from "../../src/infrastructure/Task/AbstractTask";
import {Task} from "../../src/decorators/Task/Task";

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

jest.mock('fs');

afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
});

jest.mock('/tasks/SimpleTask.js', () => ({
    SimpleTask: class SimpleTask {},
}), { virtual: true });

jest.mock('/tasks/AdvancedTask.js', () => ({
    AdvancedTask: class AdvancedTask {},
}), { virtual: true });

jest.mock('/tasks-a/SimpleTask.js', () => ({
    SimpleTask: class SimpleTask {},
}), { virtual: true });

jest.mock('/tasks-b/SimpleTask.js', () => ({
    SimpleTask: class SimpleTask {},
}), { virtual: true });

jest.mock('../../src/utils', () => ({
    Class: {
        isInheritedFrom: jest.fn(),
    },
    Path: {
        resolve: jest.fn().mockImplementation((...args) => args.join('/')),
    }
}));

describe('TaskService class', () => {
    test('should call "registerTasks" with given when instance is being created', () => {
        const registerTasksMock = jest.spyOn(TaskService.prototype as any, 'registerTasks').mockImplementation(function (this: TaskService) {});

        const tasksPath: string = './tasks';
        new TaskService(mockLogger, [tasksPath]);

        expect(registerTasksMock).toHaveBeenCalledTimes(1);

        expect(registerTasksMock).toHaveBeenCalledWith([tasksPath]);

        registerTasksMock.mockRestore();
    });

    test('"registerTasks" method should read the given directory content and pass result to Path.resolve', () => {
        (fs.readdirSync as jest.Mock).mockReturnValue(['SimpleTask.js', 'AdvancedTask.js']);
        (fs.existsSync as jest.Mock).mockReturnValue(true);

        const { Path } = require('../../src/utils');
        (Path.resolve as jest.Mock).mockImplementation((tasksPath: string, file?: string) => {
            return (file) ? `${tasksPath}/${file}` : tasksPath;
        });

        const tasksPath: string = '/tasks';
        const taskService: TaskService = new TaskService(mockLogger, [tasksPath]);

        expect(Path.resolve).toHaveBeenCalledWith(tasksPath, 'SimpleTask.js');
        expect(Path.resolve).toHaveBeenCalledWith(tasksPath, 'AdvancedTask.js');
    });

    test('"registerTasks" method should test all class for IsWorker metadata', () => {
        (fs.readdirSync as jest.Mock).mockReturnValue(['SimpleTask.js', 'AdvancedTask.js']);
        (fs.existsSync as jest.Mock).mockReturnValue(true);

        jest.spyOn(Reflect, 'getMetadata').mockImplementation((metadataKey: string, target: any) => {
            return undefined;
        });

        const { Path } = require('../../src/utils');
        (Path.resolve as jest.Mock).mockImplementation((tasksPath: string, file?: string) => {
            return (file) ? `${tasksPath}/${file}` : tasksPath;
        });

        const tasksPath: string = '/tasks';
        const taskService: TaskService = new TaskService(mockLogger, [tasksPath]);

        const SimpleTask = require('/tasks/SimpleTask.js').SimpleTask;
        const AdvancedTask = require('/tasks/AdvancedTask.js').AdvancedTask;

        expect(Reflect.getMetadata).toHaveBeenCalledWith("IsWorker", SimpleTask);
        expect(Reflect.getMetadata).toHaveBeenCalledWith("IsWorker", AdvancedTask);
    });

    test('"registerTasks" method should test all class for TaskName metadata', () => {
        (fs.readdirSync as jest.Mock).mockReturnValue(['SimpleTask.js', 'AdvancedTask.js']);
        (fs.existsSync as jest.Mock).mockReturnValue(true);

        jest.spyOn(Reflect, 'getMetadata').mockImplementation((metadataKey: string, target: any) => {
            if (metadataKey === 'IsWorker' && (target.name === 'SimpleTask' || target.name === 'AdvancedTask')) {
                return true;
            }
            if (metadataKey === 'TaskName' && (target.name === 'SimpleTask' || target.name === 'AdvancedTask')) {
                return 'someTask';
            }
            return undefined;
        });

        const { Class, Path } = require('../../src/utils');
        (Class.isInheritedFrom as jest.Mock).mockReturnValue(true);
        (Path.resolve as jest.Mock).mockImplementation((tasksPath: string, file?: string) => {
            return (file) ? `${tasksPath}/${file}` : tasksPath;
        });

        const tasksPath: string = '/tasks';
        const taskService: TaskService = new TaskService(mockLogger, [tasksPath]);

        const SimpleTask = require('/tasks/SimpleTask.js').SimpleTask;
        const AdvancedTask = require('/tasks/AdvancedTask.js').AdvancedTask;

        expect(Reflect.getMetadata).toHaveBeenCalledWith("TaskName", SimpleTask);
        expect(Reflect.getMetadata).toHaveBeenCalledWith("TaskName", AdvancedTask);
    });

    test('"registerTasks" method should test all class for AbstractTask inheritance', () => {
        (fs.readdirSync as jest.Mock).mockReturnValue(['SimpleTask.js', 'AdvancedTask.js']);
        (fs.existsSync as jest.Mock).mockReturnValue(true);

        jest.spyOn(Reflect, 'getMetadata').mockImplementation((metadataKey: string, target: any) => {
            if (metadataKey === 'TaskName' && target.name === 'SimpleTask') {
                return 'simpleTask';
            }
            if (metadataKey === 'IsWorker' && target.name === 'SimpleTask') {
                return true;
            }

            if (metadataKey === 'TaskName' && target.name === 'AdvancedTask') {
                return 'advancedTask';
            }
            if (metadataKey === 'IsWorker' && target.name === 'AdvancedTask') {
                return true;
            }

            return undefined;
        });

        const { Class, Path } = require('../../src/utils');
        (Class.isInheritedFrom as jest.Mock).mockImplementation((targetClass) => {
            return false;
        });
        (Path.resolve as jest.Mock).mockImplementation((tasksPath: string, file?: string) => {
            return (file) ? `${tasksPath}/${file}` : tasksPath;
        });

        const tasksPath: string = '/tasks';
        const taskService: TaskService = new TaskService(mockLogger, [tasksPath]);

        const SimpleTask = require('/tasks/SimpleTask.js').SimpleTask;
        const AdvancedTask = require('/tasks/AdvancedTask.js').AdvancedTask;
        const AbstractTask = require('../../src/infrastructure/Task/AbstractTask').AbstractTask;

        expect(Class.isInheritedFrom).toHaveBeenNthCalledWith(1, SimpleTask, AbstractTask);
        expect(Class.isInheritedFrom).toHaveBeenNthCalledWith(2, AdvancedTask, AbstractTask);
    });

    test('"registerTasks" method should read the given directory content', () => {
        (fs.readdirSync as jest.Mock).mockReturnValue(['SimpleTask.js', 'AdvancedTask.js']);
        (fs.existsSync as jest.Mock).mockReturnValue(true);

        jest.spyOn(Reflect, 'getMetadata').mockImplementation((metadataKey: string, target: any) => {
            if (metadataKey === 'TaskName' && target.name === 'SimpleTask') {
                return 'simpleTask';
            }
            if (metadataKey === 'IsWorker' && target.name === 'SimpleTask') {
                return true;
            }

            if (metadataKey === 'TaskName' && target.name === 'AdvancedTask') {
                return 'advancedTask';
            }
            if (metadataKey === 'IsWorker' && target.name === 'AdvancedTask') {
                return true;
            }

            return undefined;
        });

        const { Class, Path } = require('../../src/utils');
        (Class.isInheritedFrom as jest.Mock).mockImplementation((targetClass) => {
            if (targetClass.name === 'SimpleTask' || targetClass.name === 'AdvancedTask') {
                return true;
            }
            return false;
        });

        const tasksPath: string = '/tasks';
        const taskService: TaskService = new TaskService(mockLogger, [tasksPath]);

        const expectedMap: Map<string, any> = new Map();
        expectedMap.set("simpleTask", {
            name: "simpleTask",
            className: "SimpleTask",
            modulePath: "/tasks/SimpleTask.js",
            options: {name: "simpleTask", autostart: false},
            stats: expect.objectContaining({status: 'registered'}),
        });
        expectedMap.set("advancedTask", {
            name: "advancedTask",
            className: "AdvancedTask",
            modulePath: "/tasks/AdvancedTask.js",
            options: {name: "advancedTask", autostart: false},
            stats: expect.objectContaining({status: 'registered'}),
        });

        expect(taskService.getRegistrations()).toEqual(expectedMap);
    });

    test('missing tasks directory logs a warning instead of throwing', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(false);

        expect(() => new TaskService(mockLogger, ['/missing/tasks'])).not.toThrow();
        expect(mockLogger.warning).toHaveBeenCalledWith(expect.stringContaining('does not exist'));
    });

    test('registers tasks from multiple paths with duplicate-name protection', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);

        (fs.readdirSync as jest.Mock).mockImplementation((path: string) => {
            if (path === '/tasks-a') {
                return ['SimpleTask.js'];
            }
            return ['SimpleTask.js'];
        });

        jest.spyOn(Reflect, 'getMetadata').mockImplementation((metadataKey: string, target: any) => {
            if (metadataKey === 'TaskName' && target.name === 'SimpleTask') {
                return 'simpleTask';
            }
            if (metadataKey === 'IsWorker' && target.name === 'SimpleTask') {
                return true;
            }
            return undefined;
        });

        const { Class, Path } = require('../../src/utils');
        (Class.isInheritedFrom as jest.Mock).mockReturnValue(true);
        (Path.resolve as jest.Mock).mockImplementation((...args: string[]) => args.join('/'));

        const taskService: TaskService = new TaskService(mockLogger, ['/tasks-a', '/tasks-b']);

        const registrations = taskService.getRegistrations();
        expect(registrations.size).toBe(1);
        expect(mockLogger.warning).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    });

    test('startTask on unknown name throws', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(false);

        const taskService: TaskService = new TaskService(mockLogger, ['/tasks']);
        expect(() => taskService.startTask('nope')).toThrow(/not a registered task/);
    });

    test('createTask on unknown name throws', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(false);

        const taskService: TaskService = new TaskService(mockLogger, ['/tasks']);
        expect(() => taskService.createTask('nope')).toThrow(/not a registered task/);
    });

    test('decorator options are read into registration (schedule, autostart)', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.readdirSync as jest.Mock).mockReturnValue(['ScheduledTask.js']);

        @Task({name: 'scheduled', schedule: '0 3 * * *', timeZone: 'UTC', autostart: true})
        class ScheduledTask extends AbstractTask {
            public executeTask(): null {
                return null;
            }
        }

        jest.mock('/tasks/ScheduledTask.js', () => ({
            ScheduledTask,
        }), { virtual: true });

        const { Class, Path } = require('../../src/utils');
        (Class.isInheritedFrom as jest.Mock).mockImplementation((target: any, base: any) => target === ScheduledTask);
        (Path.resolve as jest.Mock).mockImplementation((...args: string[]) => args.join('/'));

        const taskService: TaskService = new TaskService(mockLogger, ['/tasks']);
        const registration = taskService.getRegistrations().get('scheduled');

        expect(registration).toBeDefined();
        expect(registration!.options.schedule).toBe('0 3 * * *');
        expect(registration!.options.timeZone).toBe('UTC');
        expect(registration!.options.autostart).toBe(true);
    });
});