/** A model field was read although the query that hydrated the model did not select its column. */
export class UnloadedFieldError extends Error {
    public constructor(modelName: string, fieldName: string) {
        super(`${modelName}.${fieldName} was not selected by the query that loaded this model`);
        this.name = 'UnloadedFieldError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
