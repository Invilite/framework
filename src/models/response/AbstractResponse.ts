
export abstract class AbstractResponse {
    protected statusCode: number;
    protected headers: {[name: string]: number | string | ReadonlyArray<string>};

    abstract getData(): Buffer;

    protected constructor(protected data: any) {
        this.headers = {};
        this.statusCode = 200;
    }

    public setStatusCode(statusCode: number): AbstractResponse {
        if (statusCode < 100 || statusCode >= 600) {
            throw new Error('Status code should be a number between 100 and 599');
        }
        this.statusCode = statusCode;

        return this;
    }

    public getStatusCode(): number {
        return this.statusCode;
    }

    protected setHeader(name: string, value: number | string | ReadonlyArray<string>): AbstractResponse {
        this.headers[name] = value;

        return this;
    }

    public getHeaders(): {[name: string]: number | string | ReadonlyArray<string>} {
        return this.headers;
    }
}
