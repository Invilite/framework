import {AssertionError} from "node:assert";

export class ValidationError extends AssertionError implements Error {

    public constructor(message?: string, actual?: any, expected?: any, operator?: any) {
        super({
            message,
            actual,
            expected,
            operator,
            stackStartFn: new.target
        });
        this.name = 'ValidationError';

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

    public getActual(): unknown {
        return this.actual;
    }

    public getExpected(): unknown {
        return this.expected;
    }

    public getOperator(): unknown {
        return this.operator;
    }

    public isMessageGenerated(): boolean {
        return this.generatedMessage;
    }
}
