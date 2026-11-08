import {AbstractTask} from "../../src/infrastructure/Task/AbstractTask";

describe('AbstractTask.processNameFor', () => {
    test('prefixes the task name with the application namespace', (): void => {
        expect(AbstractTask.processNameFor('cleanup-sessions', 'app'))
            .toBe('app: task cleanup-sessions');
    });

    test('falls back to the bare task name when the prefix is undefined', (): void => {
        expect(AbstractTask.processNameFor('x', undefined)).toBe('task x');
    });

    test('falls back to the bare task name when the prefix is empty', (): void => {
        expect(AbstractTask.processNameFor('x', '')).toBe('task x');
    });
});
