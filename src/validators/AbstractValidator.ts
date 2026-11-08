import {ValidationError} from "../errors/ValidationError";

export interface ValidationIssue {
    path: string;
    code: string;
    params?: Record<string, unknown>;
}

export type ValidationResult<T> = {valid: true; data: T} | {valid: false; errors: ValidationIssue[]};

/** Checks one shape of data: validate() reports, ensure() throws ValidationError with the same issues. */
export default abstract class AbstractValidator<T> {
    public abstract validate(data: unknown): ValidationResult<T>;

    public ensure(data: unknown): T {
        const result: ValidationResult<T> = this.validate(data);
        if (!result.valid) {
            throw new ValidationError('Validation failed', result.errors);
        }

        return result.data;
    }
}
