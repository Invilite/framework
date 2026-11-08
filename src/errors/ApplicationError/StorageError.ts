import {ApplicationError} from "../ApplicationError";

/**
 * Machine-readable failure categories for the storage layer. The HTTP boundary
 * (controller) maps each code to an HttpError subclass; storage itself stays
 * HTTP-agnostic so it can be used from tasks, CLI tools and tests.
 */
export type StorageErrorCode =
    | 'NOT_FOUND'
    | 'INVALID_PATH'
    | 'WRITE_FAILED'
    | 'READ_FAILED'
    | 'DELETE_FAILED'
    | 'UNSUPPORTED';

export default class StorageError extends ApplicationError {

    public readonly code: StorageErrorCode;

    public constructor(message: string, code: StorageErrorCode) {
        super(message);
        this.name = 'StorageError';
        this.code = code;
    }

    public getCode(): StorageErrorCode {
        return this.code;
    }
}