
export class SystemError extends RangeError implements Error  {
    public readonly syscall?: string;
    public readonly path?: string;
    public readonly code?: string | undefined;
    public readonly errno?: number | undefined;

    public constructor(message: string, code?: string, errno?: number) {
        super(message);
        this.name = 'SystemError';
        this.code = code;
        this.errno = errno;

        Object.setPrototypeOf(this, new.target.prototype);
        Error.captureStackTrace(this, this.constructor);
    }

    public getMessage(): string {
        return this.message;
    }

    public getStack(): string | undefined {
        return this.stack;
    }

    public getName(): string {
        return this.name;
    }

    public getCode(): string | undefined {
        return this.code
    }

    public getNumber(): number | undefined {
        return this.errno;
    }

    public getSysCall(): string | undefined {
        return this.syscall;
    }
}
