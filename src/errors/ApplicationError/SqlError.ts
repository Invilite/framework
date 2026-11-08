import {ApplicationError} from "../ApplicationError";

export default class SqlError extends ApplicationError {
    /**
     * SQLSTATE and violated constraint of the driver error (e.g. `23505` + index name), so callers can map a unique
     * violation to a domain message - the wrapper must not swallow them.
     */
    public readonly code: string | undefined;
    public readonly constraint: string | undefined;

    public constructor(message: string, protected readonly query: string, protected readonly params: unknown[], code?: string, constraint?: string) {
        super(message);
        this.code = code;
        this.constraint = constraint;
    }

    public getQuery(): string {
        return this.query;
    }

    public getParams(): unknown[] {
        return this.params;
    }

}