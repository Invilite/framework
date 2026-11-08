/**
 * Protocol vocabulary for OpenAI-protocol chat completions. "OpenAi" names the
 * PROTOCOL, not a vendor: any OpenAI-compatible endpoint (OpenAI cloud, Ollama
 * local /v1, Ollama cloud) speaks it. Co-located with the connector because these
 * types describe its API surface, not a cross-domain contract.
 */

export type OpenAiRole = 'system' | 'user' | 'assistant';

export interface OpenAiTextPart {
    type: 'text';
    text: string;
}

export interface OpenAiImagePart {
    type: 'image';
    image: OpenAiImage;
}

export type OpenAiContentPart = OpenAiTextPart | OpenAiImagePart;

export type OpenAiContent = string | OpenAiContentPart[];

export interface OpenAiMessage {
    role: OpenAiRole;
    content: OpenAiContent;
}

/**
 * Image input in whichever form the caller already has it; the connector
 * normalizes it to what the target endpoint accepts (data URL vs remote URL).
 */
export type OpenAiImage =
    | { kind: 'buffer'; data: Buffer; mime: string }
    | { kind: 'base64'; data: string; mime: string }
    | { kind: 'url'; url: string; mime: string };

export type OpenAiFinishReason = 'stop' | 'length' | 'content_filter';

export interface OpenAiUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

export interface OpenAiCompletion {
    text: string;
    finishReason: OpenAiFinishReason;
    usage?: OpenAiUsage;
    model: string;
    /** Chain-of-thought returned separately from content (Ollama /v1 extension). */
    reasoning?: string;
}

export type OpenAiFormat = 'text' | 'json';

/**
 * Thinking control: boolean uses the Ollama-style `think` switch,
 * a string level uses the OpenAI-style `reasoning_effort`. Never both.
 */
export type OpenAiThinking = boolean | 'low' | 'medium' | 'high';

export interface OpenAiCompleteOptions {
    model?: string;
    timeout?: number;
    temperature?: number;
    maxTokens?: number;
    /**
     * Structured output ('json' maps to response_format json_object). Support
     * depends on the target endpoint - verify before relying on it with
     * OpenAI-compatible backends other than OpenAI itself.
     */
    format?: OpenAiFormat;
    maxImageBytes?: number;
    thinking?: OpenAiThinking;
}

export interface OpenAiConnectorConfig {
    apiKey: string;
    model: string;
    /** Undefined = SDK default (https://api.openai.com/v1). */
    baseURL?: string;
    timeout?: number;
    maxImageBytes?: number;
    /** Fetch URL images connector-side and inline as base64 (needed by Ollama /v1). */
    fetchImages?: boolean;
    /** Connector identity in logs/errors; defaults to the model name. */
    name?: string;
}

/** Minimal surface consumers depend on (also the test seam for facades). */
export interface OpenAiClient {
    readonly name: string;

    complete(messages: OpenAiMessage[], options?: OpenAiCompleteOptions): Promise<OpenAiCompletion>;
}
