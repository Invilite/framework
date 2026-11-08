import axios from "axios";
import {APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, OpenAI} from "openai";
import {SecretGuard} from "../../decorators/SecretGuard";
import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {
    OpenAiClient,
    OpenAiCompleteOptions,
    OpenAiCompletion,
    OpenAiConnectorConfig,
    OpenAiContent,
    OpenAiFinishReason,
    OpenAiImage,
    OpenAiMessage,
    OpenAiThinking,
} from "./OpenAiTypes";
import {
    AiAuthError,
    AiConnectorError,
    AiContentFilterError,
    AiImageTooLargeError,
    AiInvalidResponseError,
    AiModelError,
    AiProviderUnavailableError,
    AiRateLimitError,
    AiTimeoutError,
} from "./OpenAiErrors";

const DEFAULT_TIMEOUT_MS: number = 60_000;
const DEFAULT_MAX_IMAGE_BYTES: number = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS: number = 30_000;

type NormalizedContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

interface NormalizedMessage {
    role: OpenAiMessage["role"];
    content: string | NormalizedContentPart[];
}

/**
 * OpenAI-protocol chat completions connector, constructed directly with explicit
 * parameters (any OpenAI-compatible endpoint via baseURL override). SDK-internal
 * retries are disabled - retry policy belongs to callers, guided by the
 * `retryable` flag on errors.
 */
@SecretGuard
export default class OpenAiConnector implements OpenAiClient {
    public readonly name: string;
    private readonly client: OpenAI;
    private readonly defaultModel: string;
    private readonly defaultTimeout: number;
    private readonly maxImageBytes: number;
    private readonly fetchImages: boolean;

    public constructor(config: OpenAiConnectorConfig, private readonly logger: AbstractLogger) {
        const model: string = config.model.trim();
        if (model.length === 0) {
            throw new Error("OpenAiConnector requires a non-empty model");
        }

        if (config.apiKey.trim().length === 0) {
            throw new Error("OpenAiConnector requires a non-empty apiKey");
        }

        this.name = config.name?.trim() || model;
        this.defaultModel = model;
        this.defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
        this.maxImageBytes = config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
        this.fetchImages = config.fetchImages ?? false;
        this.client = new OpenAI({
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            timeout: this.defaultTimeout,
            maxRetries: 0,
        });
    }

    public async complete(messages: OpenAiMessage[], options?: OpenAiCompleteOptions): Promise<OpenAiCompletion> {
        const maxImageBytes: number = options?.maxImageBytes ?? this.maxImageBytes;

        const normalized: NormalizedMessage[] = [];
        for (const message of messages) {
            normalized.push({
                role: message.role,
                content: await this.normalizeContent(message.content, maxImageBytes),
            });
        }

        const model: string = options?.model ?? this.defaultModel;

        const body = {
            model,
            messages: normalized as OpenAI.Chat.ChatCompletionMessageParam[],
            ...(options?.temperature !== undefined ? {temperature: options.temperature} : {}),
            ...(options?.maxTokens !== undefined ? {max_tokens: options.maxTokens} : {}),
            ...(options?.format === "json" ? {response_format: {type: "json_object"} as const} : {}),
            ...this.resolveThinking(options?.thinking),
        };

        const startedAt: number = Date.now();
        this.logger.debug(
            `[${this.name}] -> ${model}, ${normalized.length} messages, thinking=${options?.thinking ?? "default"}, format=${options?.format ?? "text"}, temperature=${options?.temperature ?? "default"}`,
        );

        try {
            const response: OpenAI.Chat.ChatCompletion = await this.client.chat.completions.create(
                body,
                {timeout: options?.timeout ?? this.defaultTimeout},
            );

            const completion: OpenAiCompletion = this.parseResponse(response, model);
            this.logger.debug(`[${this.name}] <- ${completion.model} in ${Date.now() - startedAt}ms (finish=${completion.finishReason}, tokens=${completion.usage?.promptTokens ?? "?"}/${completion.usage?.completionTokens ?? "?"})`);

            return completion;
        } catch (error) {
            this.logger.debug(`[${this.name}] failed in ${Date.now() - startedAt}ms: ${(error as Error).message}`);
            throw this.wrapError(error);
        }
    }

    /** Boolean uses the Ollama `think` switch, string levels use OpenAI `reasoning_effort` - never both. */
    private resolveThinking(thinking: OpenAiThinking | undefined): Record<string, boolean | string> {
        if (thinking === undefined) {
            return {};
        }

        if (thinking === true) {
            return {think: true};
        }

        if (thinking === false) {
            return {think: false};
        }

        return {reasoning_effort: thinking};
    }

    private async normalizeContent(content: OpenAiContent, maxImageBytes: number): Promise<string | NormalizedContentPart[]> {
        if (typeof content === "string") {
            return content;
        }

        const parts: NormalizedContentPart[] = [];
        for (const part of content) {
            if (part.type === "text") {
                parts.push({type: "text", text: part.text});
            } else {
                parts.push({type: "image_url", image_url: {url: await this.normalizeImage(part.image, maxImageBytes)}});
            }
        }

        return parts;
    }

    private async normalizeImage(image: OpenAiImage, maxImageBytes: number): Promise<string> {
        switch (image.kind) {
            case "buffer":
                this.assertImageSize(image.data.byteLength, maxImageBytes);
                return this.toDataUrl(image.data, image.mime);
            case "base64": {
                const buffer: Buffer = Buffer.from(image.data, "base64");
                this.assertImageSize(buffer.byteLength, maxImageBytes);
                return this.toDataUrl(buffer, image.mime);
            }
            case "url": {
                // Endpoints that fetch images server-side (OpenAI cloud) receive the URL as-is.
                if (!this.fetchImages) {
                    return image.url;
                }

                const buffer: Buffer = await this.fetchImage(image.url, maxImageBytes);
                this.assertImageSize(buffer.byteLength, maxImageBytes);
                return this.toDataUrl(buffer, image.mime);
            }
        }
    }

    private toDataUrl(buffer: Buffer, mime: string): string {
        return `data:${mime};base64,${buffer.toString("base64")}`;
    }

    /**
     * Downloads an image for endpoints that require inline base64 (e.g. Ollama /v1).
     * URL must come from a trusted source (Seaweed) - this method performs no SSRF
     * validation.
     */
    private async fetchImage(url: string, maxBytes: number): Promise<Buffer> {
        try {
            const response = await axios.get(url, {
                responseType: "arraybuffer",
                timeout: IMAGE_FETCH_TIMEOUT_MS,
                maxContentLength: maxBytes,
                maxBodyLength: maxBytes,
            });

            return Buffer.from(response.data);
        } catch (error) {
            throw new AiProviderUnavailableError(
                `Failed to fetch image from "${url}": ${(error as Error).message}`,
                this.name,
                error,
            );
        }
    }

    private assertImageSize(byteLength: number, maxBytes: number): void {
        if (byteLength > maxBytes) {
            throw new AiImageTooLargeError(
                `Image exceeds the configured limit: ${byteLength} bytes > ${maxBytes} bytes`,
                this.name,
            );
        }
    }

    private parseResponse(response: OpenAI.Chat.ChatCompletion, requestedModel: string): OpenAiCompletion {
        const message: OpenAI.Chat.ChatCompletionMessage | undefined = response.choices?.[0]?.message;
        const text: string | null | undefined = message?.content;

        if (typeof text !== "string") {
            throw new AiInvalidResponseError(
                `Instance "${this.name}" returned no message content`,
                this.name,
            );
        }

        // `reasoning` is an Ollama /v1 extension, absent from the SDK types.
        const rawReasoning: unknown = (message as {reasoning?: unknown}).reasoning;

        return {
            text,
            reasoning: typeof rawReasoning === "string" && rawReasoning.length > 0 ? rawReasoning : undefined,
            finishReason: this.mapFinishReason(response.choices[0]?.finish_reason),
            usage: response.usage ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
            } : undefined,
            model: response.model ?? requestedModel,
        };
    }

    private mapFinishReason(reason: string | null | undefined): OpenAiFinishReason {
        if (reason === "length" || reason === "content_filter") {
            return reason;
        }

        // OpenAI-compatible backends (e.g. Ollama /v1) may report values outside
        // the OpenAI set; treat any completed generation as a regular stop.
        if (reason !== "stop" && reason !== null && reason !== undefined) {
            this.logger.warning(`[OpenAiConnector:${this.name}] Unknown finish_reason "${reason}", mapped to "stop"`);
        }

        return "stop";
    }

    private wrapError(error: unknown): AiConnectorError {
        if (error instanceof AiConnectorError) {
            return error;
        }

        if (error instanceof APIConnectionTimeoutError) {
            return new AiTimeoutError(`Instance "${this.name}" timed out`, this.name, error);
        }

        if (error instanceof APIConnectionError) {
            return new AiProviderUnavailableError(`Instance "${this.name}" is unreachable`, this.name, error);
        }

        if (error instanceof APIUserAbortError) {
            return new AiInvalidResponseError(`Request to instance "${this.name}" was aborted locally`, this.name, error);
        }

        if (error instanceof APIError) {
            const message: string = `Instance "${this.name}" responded with HTTP ${error.status ?? "?"}: ${error.message}`;

            switch (error.status) {
                case 401:
                case 403:
                    return new AiAuthError(message, this.name, error);
                case 404:
                    return new AiModelError(message, this.name, error);
                case 429:
                    return new AiRateLimitError(message, this.name, error);
                default:
                    if ((error.status ?? 0) >= 500) {
                        return new AiProviderUnavailableError(message, this.name, error);
                    }

                    if (this.isContentFilterRejection(error)) {
                        return new AiContentFilterError(message, this.name, error);
                    }

                    return new AiInvalidResponseError(message, this.name, error);
            }
        }

        return new AiProviderUnavailableError(`Instance "${this.name}" failed unexpectedly: ${(error as Error).message}`, this.name, error);
    }

    private isContentFilterRejection(error: APIError): boolean {
        const errorCode: unknown = (error.error as {code?: unknown} | undefined)?.code;

        return errorCode === "content_filter" || errorCode === "moderation_blocked";
    }
}
