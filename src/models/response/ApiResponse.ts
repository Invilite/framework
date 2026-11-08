import {JsonResponse} from "./JsonResponse";
import {ZodError} from "zod";
import TranslationService from "../../services/TranslationService";

export type ApiErrorResponse = {
    type?: string,
    errorCode?: number,
    message: string,
    details: string | null,
    traceId?: string,
}

export type FieldError = {
    code: string,
    message: string,
    details: string,
}

export default class ApiResponse extends JsonResponse {
    public validateRequest(): void {

    }

    public constructor(protected readonly apiVersion: number = 1, requestId: string | undefined) {
        super({
            status: {
                success: true,
                code: 0,
            },
            data: null,
            errors: [],
            meta: {
                apiVersion: null,
                requestId: requestId,
                timestamp: new Date(),
            },
            redirect: false,
            fields: new Map<string, FieldError>(),
        });

        this.data.meta.apiVersion = this.apiVersion;
    }

    public getData(): Buffer {
        this.data.status.code = this.getStatusCode();

        return super.getData();
    }

    public setSuccess(success: boolean): this {
        this.data.status.success = success;
        return this;
    }

    public setData(data: any): this {
        this.data.data = data;
        return this;
    }

    public addError(error: ApiErrorResponse): this {
        this.data.errors.push(error);
        return this;
    }

    public cleanErrors(): this {
        this.data.errors.length = 0;
        return this;
    }

    public hasErrors(): boolean {
        return (this.data.errors.length > 0 || this.data.fields.size() > 0);
    }

    public setRedirect(url: string | false): this {
        this.data.redirect = url;
        return this;
    }

    public getRedirect(): string | false {
        return this.data.redirect;
    }

    public addFieldErrors(fieldName: string, error: FieldError): this {
        let existingErrors = this.data.fields.get(fieldName);
        if (!existingErrors) {
            this.data.fields.set(fieldName, []);
            existingErrors = [];
        }
        existingErrors.push({
            code: error.code,
            message: TranslationService.forZodError(error.code) || error.message,
            details: error.details,
        });
        this.data.fields.set(fieldName, existingErrors);
        return this;
    }

    public clearFieldErrors(): this {
        this.data.fields.clear();
        return this;
    }

    public fromZodError(error: ZodError): this {
        const fieldErrors: any[] = error.issues.map(issue => ({
            field: issue.path.join("."),
            message: issue.message,
            details: issue.message,
            code: issue.code
        }));

        for (const fieldError of fieldErrors) {
            this.addFieldErrors(fieldError.field, {
                code: fieldError.code,
                message: fieldError.message,
                details: fieldError.message,
            });
        }

        return this;
    }
}