type Resolve<T> = (value: T | undefined) => void;

export default class Latch<T = undefined> {
    private readonly promise: Promise<T | undefined>;
    private released: boolean = false;
    private value: T | undefined;
    private resolveFn!: Resolve<T | undefined>;
    private handlers: Resolve<T | undefined>[] = [];

    public constructor() {
        this.released = false;
        this.promise = new Promise<T | undefined>((resolve): void => {
            this.resolveFn = resolve;
        });
    }

    public wait(cb: (value?: T) => void): void {
        if (this.released) {
            return cb(this.value!);
        }

        this.handlers.push(cb);
    }

    public waitAsync(): Promise<T | undefined> {
        if (this.released) {
            return Promise.resolve(this.value!);
        }

        return this.promise;
    }

    public release(value?: T): void {
        if (this.released) {
            return;
        }

        this.value = value;
        this.released = true;

        for (const cb of this.handlers) {
            try {
                cb(value);
            } catch {
            }
        }
        this.handlers = [];
        this.resolveFn(value);
    }

    public isReleased(): boolean {
        return this.released;
    }
}