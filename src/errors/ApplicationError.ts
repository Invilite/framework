
export class ApplicationError extends TypeError implements Error  {

    public constructor(message: string) {
        super(message);
        this.name = 'ApplicationError';

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
}
