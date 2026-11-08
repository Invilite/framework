import axios, {AxiosError} from "axios";
import {SecretGuard} from "../../decorators/SecretGuard";
import {AbstractLogger} from "../../types/interfaces/AbstractLogger";
import {
    OpenAiClient,
    OpenAiCompleteOptions,
    OpenAiCompletion,
    OpenAiImage,
    OpenAiMessage,
} from "../OpenAi/OpenAiTypes";
import {
    AiAuthError,
    AiConnectorError,
    AiImageTooLargeError,
    AiInvalidResponseError,
    AiModelError,
    AiProviderUnavailableError,
    AiRateLimitError,
    AiTimeoutError,
} from "../OpenAi/OpenAiErrors";
import {
    OllamaDecideOptions,
    OllamaDecision,
    OllamaDecisionAnswer,
    OllamaDecisionAnswers,
    OllamaDecisionClient,
    OllamaDecisionQuestion,
    OllamaDecisionQuestions,
    OllamaDecisionState,
} from "./OllamaDecisionTypes";

const DEFAULT_TIMEOUT_MS: number = 60_000;
const DEFAULT_MAX_IMAGE_BYTES: number = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS: number = 30_000;

/** Limity chmury dla /v1/systemone — przekroczenie to nieczytelne 400, więc odrzucamy przed requestem. */
const DECISION_MAX_QUESTIONS: number = 64;
const DECISION_QUESTION_NAME: RegExp = /^[A-Za-z0-9_.-]{1,100}$/;
const DECISION_MAX_SCORE_LEVELS: number = 10;
const DECISION_MAX_IMAGES: number = 4;
const DECISION_MAX_IMAGE_BYTES: number = 4 * 1024 * 1024;
const DECISION_MAX_TOTAL_IMAGE_BYTES: number = 8 * 1024 * 1024;

/** 400 Ollamy, gdy model nie pasuje do API: decyzyjny na /api/chat albo czatowy na /v1/systemone. */
const WRONG_MODEL_KIND: RegExp = /does not support chat|is not a .*decision model/;

/** Natywne API Ollama nie przyjmuje URL-i obrazów — zawsze inline base64. */
interface NativeMessage {
    role: string;
    content: string;
    images?: string[];
}

interface NativeChatResponse {
    message?: { content?: string; thinking?: string };
    done_reason?: string | null;
    prompt_eval_count?: number;
    eval_count?: number;
}

interface NativeDecisionResponse {
    answers?: Record<string, unknown>;
    usage?: { input_tokens?: number };
}

export interface OllamaConnectorConfig {
    apiKey: string;
    model: string;
    /** Baza hosta (np. https://ollama.com) — endpoint /api/chat jest doklejany. */
    baseURL?: string;
    timeout?: number;
    maxImageBytes?: number;
    /** Connector identity in logs/errors; defaults to the model name. */
    name?: string;
}

/**
 * Konektor mówiący NATYWNYM protokołem Ollamy (/api/chat). Implementuje ten sam
 * interfejs co OpenAiConnector, ale przez endpoint, który honoruje parametry
 * specyficzne dla Ollamy — przede wszystkim `think` (OpenAI-compat /v1 na
 * ollama.com ignoruje go, więc modele reasoningowe nie da się tam wyciszyć).
 * Obrazy zawsze lądują inline jako base64 (natywne API nie ma forme URL).
 *
 * `decide()` woła API decyzyjne (/v1/systemone) dla modeli typu clef, które nie
 * obsługują czatu. Model instancji musi pasować do metody — zły rodzaj modelu
 * kończy się AiModelError.
 */
@SecretGuard
export default class OllamaConnector implements OpenAiClient, OllamaDecisionClient {
    public readonly name: string;
    private readonly baseURL: string;
    private readonly apiKey: string;
    private readonly defaultModel: string;
    private readonly defaultTimeout: number;
    private readonly maxImageBytes: number;

    public constructor(config: OllamaConnectorConfig, private readonly logger: AbstractLogger) {
        const model: string = config.model.trim();
        if (model.length === 0) {
            throw new Error("OllamaConnector requires a non-empty model");
        }

        if (config.apiKey.trim().length === 0) {
            throw new Error("OllamaConnector requires a non-empty apiKey");
        }

        this.name = config.name?.trim() || model;
        this.baseURL = (config.baseURL ?? "https://ollama.com").replace(/\/$/, "");
        this.apiKey = config.apiKey;
        this.defaultModel = model;
        this.defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
        this.maxImageBytes = config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    }

    public async complete(messages: OpenAiMessage[], options?: OpenAiCompleteOptions): Promise<OpenAiCompletion> {
        const maxImageBytes: number = options?.maxImageBytes ?? this.maxImageBytes;
        const nativeMessages: NativeMessage[] = [];
        for (const message of messages) {
            nativeMessages.push(await this.normalizeMessage(message, maxImageBytes));
        }

        const ollamaOptions: Record<string, unknown> = {};
        if (options?.temperature !== undefined) {
            ollamaOptions.temperature = options.temperature;
        }
        if (options?.maxTokens !== undefined) {
            ollamaOptions.num_predict = options.maxTokens;
        }

        const body: Record<string, unknown> = {
            model: options?.model ?? this.defaultModel,
            messages: nativeMessages,
            stream: false,
            ...(Object.keys(ollamaOptions).length > 0 ? {options: ollamaOptions} : {}),
            ...(options?.format === "json" ? {format: "json"} : {}),
        };
        if (options?.thinking !== undefined) {
            // Natywne API ma tylko przełącznik boolean; poziomy 'low'/'medium'/'high'
            // to dialekt OpenAI-compat — ciche zcoerowanie do false odwróciłoby intencję.
            if (options.thinking !== true && options.thinking !== false) {
                throw new Error("OllamaConnector supports only boolean thinking (native API has no effort levels)");
            }
            body.think = options.thinking;
        }

        const startedAt: number = Date.now();
        this.logger.debug(
            `[${this.name}] -> ${body.model}, ${nativeMessages.length} messages, think=${body.think ?? "default"}, format=${options?.format ?? "text"}`,
        );

        try {
            const response = await axios.post<NativeChatResponse>(`${this.baseURL}/api/chat`, body, {
                headers: {Authorization: `Bearer ${this.apiKey}`},
                timeout: options?.timeout ?? this.defaultTimeout,
            });

            const completion: OpenAiCompletion = this.parseResponse(response.data, String(body.model));
            this.logger.debug(`[${this.name}] <- ${completion.model} in ${Date.now() - startedAt}ms (finish=${completion.finishReason}, tokens=${completion.usage?.promptTokens ?? "?"}/${completion.usage?.completionTokens ?? "?"})`);

            return completion;
        } catch (error) {
            this.logger.debug(`[${this.name}] failed in ${Date.now() - startedAt}ms: ${(error as Error).message}`);
            throw this.wrapError(error);
        }
    }

    public async decide<Q extends OllamaDecisionQuestions>(
        state: OllamaDecisionState,
        questions: Q,
        options?: OllamaDecideOptions,
    ): Promise<OllamaDecision<Q>> {
        this.validateQuestions(questions);
        const images: string[] = await this.normalizeDecisionImages(
            options?.images ?? [],
            options?.maxImageBytes ?? DECISION_MAX_IMAGE_BYTES,
        );

        const model: string = options?.model ?? this.defaultModel;
        const body: Record<string, unknown> = {
            model,
            state,
            questions,
            ...(images.length > 0 ? {images} : {}),
        };

        const startedAt: number = Date.now();
        this.logger.debug(`[${this.name}] decide -> ${model}, ${Object.keys(questions).length} questions, ${images.length} images`);

        try {
            const response = await axios.post<NativeDecisionResponse>(`${this.baseURL}/v1/systemone`, body, {
                headers: {Authorization: `Bearer ${this.apiKey}`},
                timeout: options?.timeout ?? this.defaultTimeout,
            });

            const decision: OllamaDecision<Q> = this.parseDecision(response.data, questions, model);
            this.logger.debug(`[${this.name}] decide <- ${model} in ${Date.now() - startedAt}ms (tokens=${decision.usage.inputTokens ?? "?"})`);

            return decision;
        } catch (error) {
            this.logger.debug(`[${this.name}] decide failed in ${Date.now() - startedAt}ms: ${(error as Error).message}`);
            throw this.wrapError(error);
        }
    }

    private validateQuestions(questions: OllamaDecisionQuestions): void {
        const names: string[] = Object.keys(questions);
        if (names.length < 1 || names.length > DECISION_MAX_QUESTIONS) {
            throw new Error(`OllamaConnector.decide needs 1 to ${DECISION_MAX_QUESTIONS} questions, got ${names.length}`);
        }

        for (const name of names) {
            if (!DECISION_QUESTION_NAME.test(name)) {
                throw new Error(`Invalid question name "${name}": letters, digits, "_", "." or "-", up to 100 characters`);
            }

            const question: OllamaDecisionQuestion = questions[name];
            if (question.type === "choice" && Object.keys(question.criteria).length < 2) {
                throw new Error(`Question "${name}": choice needs at least 2 options`);
            }
            if (question.type === "score" && (question.criteria.length < 2 || question.criteria.length > DECISION_MAX_SCORE_LEVELS)) {
                throw new Error(`Question "${name}": score needs 2 to ${DECISION_MAX_SCORE_LEVELS} levels`);
            }
        }
    }

    private async normalizeDecisionImages(images: OpenAiImage[], maxImageBytes: number): Promise<string[]> {
        if (images.length > DECISION_MAX_IMAGES) {
            throw new AiImageTooLargeError(`Decision request takes at most ${DECISION_MAX_IMAGES} images, got ${images.length}`, this.name);
        }

        const encoded: string[] = [];
        let totalBytes: number = 0;
        for (const image of images) {
            const base64: string = await this.normalizeImage(image, maxImageBytes);
            totalBytes += Buffer.byteLength(base64, "base64");
            encoded.push(base64);
        }

        if (totalBytes > DECISION_MAX_TOTAL_IMAGE_BYTES) {
            throw new AiImageTooLargeError(
                `Images exceed the total limit: ${totalBytes} bytes > ${DECISION_MAX_TOTAL_IMAGE_BYTES} bytes`,
                this.name,
            );
        }

        return encoded;
    }

    private parseDecision<Q extends OllamaDecisionQuestions>(
        data: NativeDecisionResponse,
        questions: Q,
        requestedModel: string,
    ): OllamaDecision<Q> {
        const answers: Record<string, OllamaDecisionAnswer> = {};
        for (const [name, question] of Object.entries(questions)) {
            const answer: unknown = data.answers?.[name];
            if (!this.isAnswerTo(question, answer)) {
                throw new AiInvalidResponseError(
                    `Instance "${this.name}" returned no valid "${question.type}" answer to "${name}"`,
                    this.name,
                );
            }
            answers[name] = answer;
        }

        return {
            answers: answers as OllamaDecisionAnswers<Q>,
            usage: {inputTokens: data.usage?.input_tokens},
            model: requestedModel,
        };
    }

    private isAnswerTo(question: OllamaDecisionQuestion, answer: unknown): answer is OllamaDecisionAnswer {
        if (typeof answer !== "object" || answer === null) {
            return false;
        }

        const fields: Record<string, unknown> = answer as Record<string, unknown>;
        if (fields.type !== question.type) {
            return false;
        }

        const hasProbabilities: boolean = typeof fields.probabilities === "object" && fields.probabilities !== null
            && typeof fields.confidence === "number";
        switch (question.type) {
            case "choice":
                return typeof fields.choice === "string" && hasProbabilities;
            case "noul":
                return typeof fields.noul === "number";
            case "score":
                return typeof fields.score === "number" && hasProbabilities;
        }
    }

    private async normalizeMessage(message: OpenAiMessage, maxImageBytes: number): Promise<NativeMessage> {
        if (typeof message.content === "string") {
            return {role: message.role, content: message.content};
        }

        const texts: string[] = [];
        const images: string[] = [];
        for (const part of message.content) {
            if (part.type === "text") {
                texts.push(part.text);
            } else {
                images.push(await this.normalizeImage(part.image, maxImageBytes));
            }
        }

        return {
            role: message.role,
            content: texts.join("\n"),
            ...(images.length > 0 ? {images} : {}),
        };
    }

    private async normalizeImage(image: OpenAiImage, maxImageBytes: number): Promise<string> {
        let buffer: Buffer;
        switch (image.kind) {
            case "buffer":
                buffer = image.data;
                break;
            case "base64":
                buffer = Buffer.from(image.data, "base64");
                break;
            case "url":
                buffer = await this.fetchImage(image.url, maxImageBytes);
                break;
        }

        if (buffer.byteLength > maxImageBytes) {
            throw new AiImageTooLargeError(
                `Image exceeds the configured limit: ${buffer.byteLength} bytes > ${maxImageBytes} bytes`,
                this.name,
            );
        }

        return buffer.toString("base64");
    }

    /**
     * Downloads an image for inline base64 (native API has no URL form).
     * URL must come from a trusted source (Seaweed) - no SSRF validation here.
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
                OllamaConnector.sanitizedCause(error),
            );
        }
    }

    private parseResponse(data: NativeChatResponse, requestedModel: string): OpenAiCompletion {
        const content: string | undefined = data.message?.content;

        if (typeof content !== "string") {
            throw new AiInvalidResponseError(
                `Instance "${this.name}" returned no message content`,
                this.name,
            );
        }

        const reasoning: string | undefined = data.message?.thinking;
        const doneReason: string | null | undefined = data.done_reason;
        if (doneReason !== "stop" && doneReason !== "length" && doneReason !== null && doneReason !== undefined) {
            this.logger.warning(`[OllamaConnector:${this.name}] Unknown done_reason "${doneReason}", mapped to "stop"`);
        }

        const promptTokens: number | undefined = data.prompt_eval_count;
        const completionTokens: number | undefined = data.eval_count;

        return {
            text: content,
            reasoning: reasoning && reasoning.length > 0 ? reasoning : undefined,
            finishReason: doneReason === "length" ? "length" : "stop",
            usage: {
                promptTokens,
                completionTokens,
                ...(promptTokens !== undefined && completionTokens !== undefined
                    ? {totalTokens: promptTokens + completionTokens}
                    : {}),
            },
            model: requestedModel,
        };
    }

    private wrapError(error: unknown): AiConnectorError {
        if (error instanceof AiConnectorError) {
            return error;
        }

        const cause: unknown = OllamaConnector.sanitizedCause(error);

        if (axios.isAxiosError(error)) {
            const axiosError: AxiosError = error;
            if (axiosError.code === "ECONNABORTED" || axiosError.code === "ETIMEDOUT") {
                return new AiTimeoutError(`Instance "${this.name}" timed out`, this.name, cause);
            }

            const status: number | undefined = axiosError.response?.status;
            const message: string = `Instance "${this.name}" responded with HTTP ${status ?? "?"}: ${axiosError.message}`;

            switch (status) {
                case 400: {
                    const providerError: unknown = (axiosError.response?.data as {error?: unknown} | undefined)?.error;
                    if (typeof providerError === "string" && WRONG_MODEL_KIND.test(providerError)) {
                        return new AiModelError(`${message} (${providerError})`, this.name, cause);
                    }

                    return new AiInvalidResponseError(message, this.name, cause);
                }
                case 401:
                case 403:
                    return new AiAuthError(message, this.name, cause);
                case 404:
                    return new AiModelError(message, this.name, cause);
                case 429:
                    return new AiRateLimitError(message, this.name, cause);
                default:
                    if ((status ?? 0) >= 500) {
                        return new AiProviderUnavailableError(message, this.name, cause);
                    }

                    return new AiInvalidResponseError(message, this.name, cause);
            }
        }

        return new AiProviderUnavailableError(`Instance "${this.name}" failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`, this.name, cause);
    }

    private static sanitizedCause(error: unknown): unknown {
        if (!axios.isAxiosError(error)) {
            return error instanceof Error ? error : new Error(String(error));
        }

        const axiosError: AxiosError = error;
        const cause: {message: string; code?: string; status?: number; responseData?: unknown} = {
            message: axiosError.message,
        };
        if (axiosError.code !== undefined) {
            cause.code = axiosError.code;
        }
        if (axiosError.response?.status !== undefined) {
            cause.status = axiosError.response.status;
        }
        if (axiosError.response?.data !== undefined) {
            cause.responseData = axiosError.response.data;
        }
        return cause;
    }
}