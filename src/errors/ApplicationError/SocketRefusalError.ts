import {ApplicationError} from "../ApplicationError";

/**
 * A refusal a socket channel controller sends to the client: `code` goes into the `error` frame, `message` only to
 * the log. Thrown from `join` (subscription refused) or from a `@SocketMessage` method (message refused).
 */
export class SocketRefusalError extends ApplicationError {
    private static readonly CODE_PATTERN: RegExp = /^[a-z][a-z0-9_]{0,31}$/;

    public constructor(public readonly code: string, message?: string) {
        super(message ?? code);
        if (!SocketRefusalError.CODE_PATTERN.test(code)) {
            throw new Error(`Invalid socket refusal code "${code}"`);
        }
        this.name = 'SocketRefusalError';
    }
}
