/**
 * Typed error taxonomy for OpenAI-protocol connector calls. The `retryable`
 * flag is the contract async consumers depend on: whether to retry or
 * dead-letter. Each subclass fixes the flag, so callers cannot misuse it.
 */

export class AiConnectorError extends Error {
    public constructor(
        message: string,
        public readonly instance: string,
        public readonly retryable: boolean,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = this.constructor.name;
    }
}

/** Target unreachable (connection refused, DNS failure, 5xx). Transient - retry makes sense. */
export class AiProviderUnavailableError extends AiConnectorError {
    public constructor(message: string, instance: string, cause?: unknown) {
        super(message, instance, true, cause);
    }
}

/** Request exceeded the configured timeout. Transient. */
export class AiTimeoutError extends AiConnectorError {
    public constructor(message: string, instance: string, cause?: unknown) {
        super(message, instance, true, cause);
    }
}

/** Rate limited (HTTP 429). Transient - retry after backoff. */
export class AiRateLimitError extends AiConnectorError {
    public constructor(message: string, instance: string, cause?: unknown) {
        super(message, instance, true, cause);
    }
}

/**
 * Model not found / not pulled on the target (HTTP 404), or of the wrong kind for the
 * endpoint (Ollama HTTP 400: decision model sent to chat or vice versa). Retrying will not help.
 */
export class AiModelError extends AiConnectorError {
    public constructor(message: string, instance: string, cause?: unknown) {
        super(message, instance, false, cause);
    }
}

/** Authentication/authorization failure (HTTP 401/403). Retrying will not help. */
export class AiAuthError extends AiConnectorError {
    public constructor(message: string, instance: string, cause?: unknown) {
        super(message, instance, false, cause);
    }
}

/** Provider refused the content (content_filter finish reason or moderation 400). */
export class AiContentFilterError extends AiConnectorError {
    public constructor(message: string, instance: string, cause?: unknown) {
        super(message, instance, false, cause);
    }
}

/** Malformed/missing fields in the provider response, or an invalid request (400). */
export class AiInvalidResponseError extends AiConnectorError {
    public constructor(message: string, instance: string, cause?: unknown) {
        super(message, instance, false, cause);
    }
}

/** Image payload exceeds the per-image size, total size or image count limit. Caller must resize or drop images. */
export class AiImageTooLargeError extends AiConnectorError {
    public constructor(message: string, instance: string, cause?: unknown) {
        super(message, instance, false, cause);
    }
}
