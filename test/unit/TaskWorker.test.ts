import {Worker} from "worker_threads";
import {TaskWorker} from "../../src/infrastructure/Task/TaskWorker";

type EventListener = (payload: unknown) => void;

function fakeWorker(): {worker: Worker; emit: (event: string, payload: unknown) => void} {
    const listeners: Map<string, EventListener[]> = new Map<string, EventListener[]>();

    const register: (event: string, callback: EventListener) => void = (event: string, callback: EventListener): void => {
        const current: EventListener[] = listeners.get(event) ?? [];
        current.push(callback);
        listeners.set(event, current);
    };

    const raw = {
        on: register,
        once: register,
        postMessage: jest.fn(),
        terminate: jest.fn().mockResolvedValue(0),
        threadId: 1,
        performance: undefined,
    };

    const emit: (event: string, payload: unknown) => void = (event: string, payload: unknown): void => {
        for (const listener of listeners.get(event) ?? []) {
            listener(payload);
        }
    };

    return {worker: raw as unknown as Worker, emit};
}

describe('TaskWorker', () => {
    it('normalizes a non-Error worker error before emitting it', (): void => {
        const {worker, emit} = fakeWorker();
        const taskWorker: TaskWorker = new TaskWorker(worker);
        const listener: jest.Mock = jest.fn();
        taskWorker.on('error', listener);

        emit('message', {error: null});

        expect(listener).toHaveBeenCalledTimes(1);
        const error: unknown = listener.mock.calls[0][0];
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('null');
    });

    it('passes a worker Error through unchanged', (): void => {
        const {worker, emit} = fakeWorker();
        const taskWorker: TaskWorker = new TaskWorker(worker);
        const listener: jest.Mock = jest.fn();
        const original: Error = new Error('boom');
        taskWorker.on('error', listener);

        emit('message', {error: original});

        expect(listener.mock.calls[0][0]).toBe(original);
    });
});
