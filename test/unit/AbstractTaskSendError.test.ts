const mockPostMessage: jest.Mock = jest.fn();

jest.mock('worker_threads', () => ({
    parentPort: {postMessage: mockPostMessage, on: jest.fn()},
    workerData: {taskName: 'test-task'},
}));

import {AbstractTask} from "../../src/infrastructure/Task/AbstractTask";

class ExposedTask extends AbstractTask {
    public constructor() {
        super();
    }

    public executeTask(): null {
        return null;
    }

    public report(error: unknown): void {
        this.sendError(error);
    }
}

describe('AbstractTask.sendError', () => {
    beforeEach((): void => {
        mockPostMessage.mockReset();
    });

    it.each([
        ['null', null, 'null'],
        ['undefined', undefined, 'undefined'],
        ['string', 'boom', 'boom'],
    ])('normalizes %s to an Error', (_label: string, value: unknown, message: string): void => {
        new ExposedTask().report(value);

        expect(mockPostMessage).toHaveBeenCalledWith({error: expect.any(Error)});
        const error: Error = mockPostMessage.mock.calls[0][0].error as Error;
        expect(error.message).toBe(message);
    });

    it('passes an Error through unchanged', (): void => {
        const original: Error = new Error('keep');

        new ExposedTask().report(original);

        expect(mockPostMessage.mock.calls[0][0].error).toBe(original);
    });
});
