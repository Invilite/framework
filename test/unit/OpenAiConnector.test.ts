jest.mock("openai", () => {
    const create: jest.Mock = jest.fn();

    // Hierarchy mirrors the real SDK: Timeout -> Connection -> APIError -> Error
    class MockAPIError extends Error {
        public constructor(
            public readonly status?: number,
            message: string = "api error",
            public readonly error?: {code?: string},
        ) {
            super(message);
        }
    }
    class MockAPIConnectionError extends MockAPIError {}
    class MockAPIConnectionTimeoutError extends MockAPIConnectionError {}
    class MockAPIUserAbortError extends MockAPIError {}

    return {
        __createMock: create,
        OpenAI: jest.fn().mockImplementation((): object => ({
            chat: {completions: {create}},
        })),
        APIError: MockAPIError,
        APIConnectionError: MockAPIConnectionError,
        APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
        APIUserAbortError: MockAPIUserAbortError,
    };
});

jest.mock("axios", () => ({
    __esModule: true,
    default: {get: jest.fn()},
}));

import axios from "axios";
import * as openaiModule from "openai";
import OpenAiConnector from "../../src/services/OpenAi/OpenAiConnector";
import {OpenAiConnectorConfig} from "../../src/services/OpenAi/OpenAiTypes";
import {
    AiAuthError,
    AiContentFilterError,
    AiImageTooLargeError,
    AiInvalidResponseError,
    AiModelError,
    AiProviderUnavailableError,
    AiRateLimitError,
    AiTimeoutError,
} from "../../src/services/OpenAi/OpenAiErrors";
import {AbstractLogger} from "../../src/types/interfaces/AbstractLogger";

const createMock: jest.Mock = (openaiModule as unknown as {__createMock: jest.Mock}).__createMock;
const axiosGet: jest.Mock = axios.get as jest.Mock;

const loggerStub: AbstractLogger = {
    trace: (): void => {},
    debug: (): void => {},
    info: (): void => {},
    notice: (): void => {},
    warning: jest.fn(),
    error: (): void => {},
    critical: (): void => {},
    alert: (): void => {},
    emergency: (): void => {},
};

const DEFAULT_MAX_IMAGE_BYTES: number = 1024 * 1024;

function buildService(config: Partial<OpenAiConnectorConfig> = {}): OpenAiConnector {
    return new OpenAiConnector({
        apiKey: "test-key",
        model: "test-model",
        timeout: 5_000,
        maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
        ...config,
    }, loggerStub);
}

function validResponse(overrides: object = {}): object {
    return {
        model: "test-model",
        choices: [{message: {content: "hello"}, finish_reason: "stop"}],
        usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15},
        ...overrides,
    };
}

describe("OpenAiConnector — normalizacja wiadomości", () => {
    beforeEach(() => {
        createMock.mockReset();
        axiosGet.mockReset();
        createMock.mockResolvedValue(validResponse());
    });

    it("przekazuje wiadomości tekstowe i mapuje usage", async () => {
        const completion = await buildService().complete([{role: "user", content: "hi"}]);

        const [body] = createMock.mock.calls[0];
        expect(body).toEqual({model: "test-model", messages: [{role: "user", content: "hi"}]});
        expect(completion).toEqual({
            text: "hello",
            finishReason: "stop",
            usage: {promptTokens: 10, completionTokens: 5, totalTokens: 15},
            model: "test-model",
        });
    });

    it("format json przekazuje response_format do SDK", async () => {
        await buildService().complete([{role: "user", content: "hi"}], {format: "json"});

        const [body] = createMock.mock.calls[0];
        expect(body.response_format).toEqual({type: "json_object"});
    });

    it("opcje per-call: model/timeout/temperature/maxTokens", async () => {
        await buildService().complete([{role: "user", content: "hi"}], {
            model: "other-model",
            timeout: 1234,
            temperature: 0.2,
            maxTokens: 77,
        });

        const [body, options] = createMock.mock.calls[0];
        expect(body.model).toBe("other-model");
        expect(body.temperature).toBe(0.2);
        expect(body.max_tokens).toBe(77);
        expect(options).toEqual({timeout: 1234});
    });

    it("obraz buffer → data URL base64", async () => {
        await buildService().complete([{
            role: "user",
            content: [
                {type: "text", text: "co to?"},
                {type: "image", image: {kind: "buffer", data: Buffer.from("abc"), mime: "image/png"}},
            ],
        }]);

        const [body] = createMock.mock.calls[0];
        expect(body.messages[0].content).toEqual([
            {type: "text", text: "co to?"},
            {type: "image_url", image_url: {url: "data:image/png;base64,YWJj"}},
        ]);
    });

    it("obraz base64 → data URL base64", async () => {
        await buildService().complete([{
            role: "user",
            content: [{type: "image", image: {kind: "base64", data: "YWJj", mime: "image/jpeg"}}],
        }]);

        const [body] = createMock.mock.calls[0];
        expect(body.messages[0].content).toEqual([
            {type: "image_url", image_url: {url: "data:image/jpeg;base64,YWJj"}},
        ]);
    });

    it("obraz url + fetchImages=false → URL przekazany bez fetcha", async () => {
        await buildService({fetchImages: false}).complete([{
            role: "user",
            content: [{type: "image", image: {kind: "url", url: "http://seaweed/img.jpg", mime: "image/jpeg"}}],
        }]);

        const [body] = createMock.mock.calls[0];
        expect(body.messages[0].content).toEqual([
            {type: "image_url", image_url: {url: "http://seaweed/img.jpg"}},
        ]);
        expect(axiosGet).not.toHaveBeenCalled();
    });

    it("obraz url + fetchImages=true → connector fetchuje i koduje do data URL", async () => {
        axiosGet.mockResolvedValue({data: Buffer.from("fetched")});

        await buildService({fetchImages: true}).complete([{
            role: "user",
            content: [{type: "image", image: {kind: "url", url: "http://seaweed/img.jpg", mime: "image/jpeg"}}],
        }]);

        expect(axiosGet).toHaveBeenCalledWith("http://seaweed/img.jpg", expect.objectContaining({
            responseType: "arraybuffer",
            maxContentLength: DEFAULT_MAX_IMAGE_BYTES,
        }));
        const [body] = createMock.mock.calls[0];
        expect(body.messages[0].content).toEqual([
            {type: "image_url", image_url: {url: `data:image/jpeg;base64,${Buffer.from("fetched").toString("base64")}`}},
        ]);
    });

    it("obraz ponad limit → AiImageTooLargeError przed wywołaniem SDK", async () => {
        await expect(buildService({maxImageBytes: 2}).complete([{
            role: "user",
            content: [{type: "image", image: {kind: "buffer", data: Buffer.from("abcdef"), mime: "image/png"}}],
        }])).rejects.toBeInstanceOf(AiImageTooLargeError);

        expect(createMock).not.toHaveBeenCalled();
    });
});

describe("OpenAiConnector — parsowanie odpowiedzi", () => {
    beforeEach(() => {
        createMock.mockReset();
    });

    it("brak treści w odpowiedzi → AiInvalidResponseError", async () => {
        createMock.mockResolvedValue(validResponse({choices: [{message: {}, finish_reason: "stop"}]}));

        await expect(buildService().complete([{role: "user", content: "hi"}]))
            .rejects.toBeInstanceOf(AiInvalidResponseError);
    });

    it("nieznany finish_reason mapowany na 'stop' (kompatybilność z Ollama /v1)", async () => {
        createMock.mockResolvedValue(validResponse({choices: [{message: {content: "x"}, finish_reason: "loaded_from_cache"}]}));

        const completion = await buildService().complete([{role: "user", content: "hi"}]);

        expect(completion.finishReason).toBe("stop");
    });

    it("brak usage w odpowiedzi → pole undefined (Ollama /v1 nie musi zwracać)", async () => {
        createMock.mockResolvedValue(validResponse({usage: undefined}));

        const completion = await buildService().complete([{role: "user", content: "hi"}]);

        expect(completion.usage).toBeUndefined();
    });
});

describe("OpenAiConnector — mapowanie błędów SDK", () => {
    // TS sees real SDK constructor signatures; runtime uses simplified mock classes - hence the cast.
    type MockApiErrorCtor = new (status?: number, message?: string, error?: {code?: string}) => Error;
    const ApiErrorMock = openaiModule.APIError as unknown as MockApiErrorCtor;
    const ConnectionErrorMock = openaiModule.APIConnectionError as unknown as MockApiErrorCtor;
    const TimeoutErrorMock = openaiModule.APIConnectionTimeoutError as unknown as MockApiErrorCtor;

    beforeEach(() => {
        createMock.mockReset();
    });

    it("timeout połączenia → AiTimeoutError (retryable)", async () => {
        createMock.mockRejectedValue(new TimeoutErrorMock(undefined, "Request timed out"));

        await expect(buildService().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiTimeoutError);
    });

    it("brak połączenia → AiProviderUnavailableError (retryable)", async () => {
        createMock.mockRejectedValue(new ConnectionErrorMock(undefined, "connect ECONNREFUSED"));

        await expect(buildService().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiProviderUnavailableError);
    });

    it("HTTP 404 → AiModelError", async () => {
        createMock.mockRejectedValue(new ApiErrorMock(404, "model not found"));

        await expect(buildService().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiModelError);
    });

    it("HTTP 401 → AiAuthError", async () => {
        createMock.mockRejectedValue(new ApiErrorMock(401, "bad key"));

        await expect(buildService().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiAuthError);
    });

    it("HTTP 429 → AiRateLimitError", async () => {
        createMock.mockRejectedValue(new ApiErrorMock(429, "rate limited"));

        await expect(buildService().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiRateLimitError);
    });

    it("HTTP 500 → AiProviderUnavailableError", async () => {
        createMock.mockRejectedValue(new ApiErrorMock(500, "boom"));

        await expect(buildService().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiProviderUnavailableError);
    });

    it("HTTP 400 z kodem content_filter → AiContentFilterError", async () => {
        createMock.mockRejectedValue(new ApiErrorMock(400, "blocked", {code: "content_filter"}));

        await expect(buildService().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiContentFilterError);
    });

    it("HTTP 400 bez content_filter → AiInvalidResponseError", async () => {
        createMock.mockRejectedValue(new ApiErrorMock(400, "invalid request"));

        await expect(buildService().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiInvalidResponseError);
    });

    it("błąd niesięgający SDK → AiProviderUnavailableError (defensywnie retryable)", async () => {
        createMock.mockRejectedValue(new Error("anything"));

        await expect(buildService().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiProviderUnavailableError);
    });

    it("lokalny abort żądania → AiInvalidResponseError (nie-myślący komunikat HTTP)", async () => {
        const AbortErrorMock = openaiModule.APIUserAbortError as unknown as MockApiErrorCtor;
        createMock.mockRejectedValue(new AbortErrorMock(undefined, "Request was aborted"));

        await expect(buildService().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiInvalidResponseError);
    });
});

describe("OpenAiConnector — konstruktor (inwarianty)", () => {
    it("pusty lub biały model rzuca", () => {
        expect(() => buildService({model: ""})).toThrow(/non-empty model/);
        expect(() => buildService({model: "   "})).toThrow(/non-empty model/);
    });

    it("pusty lub biały apiKey rzuca", () => {
        expect(() => buildService({apiKey: ""})).toThrow(/non-empty apiKey/);
        expect(() => buildService({apiKey: "   "})).toThrow(/non-empty apiKey/);
    });

    it("name domyślnie = model (trimowany); jawne name wygrywa", () => {
        expect(buildService({model: "  minimax-m3  "}).name).toBe("minimax-m3");
        expect(buildService({model: "minimax-m3", name: "scan"}).name).toBe("scan");
        expect(buildService({model: "minimax-m3", name: "  "}).name).toBe("minimax-m3");
    });
});

describe("OpenAiConnector — opcja thinking (mapowanie dialektów)", () => {
    beforeEach(() => {
        createMock.mockReset();
        createMock.mockResolvedValue(validResponse());
    });

    it("thinking:true → body.think=true, bez reasoning_effort (dialekt Ollama)", async () => {
        await buildService().complete([{role: "user", content: "hi"}], {thinking: true});

        const [body] = createMock.mock.calls[0];
        expect(body.think).toBe(true);
        expect(body).not.toHaveProperty("reasoning_effort");
    });

    it("thinking:false → body.think=false", async () => {
        await buildService().complete([{role: "user", content: "hi"}], {thinking: false});

        const [body] = createMock.mock.calls[0];
        expect(body.think).toBe(false);
        expect(body).not.toHaveProperty("reasoning_effort");
    });

    it("thinking:'high' → body.reasoning_effort='high', bez think (dialekt OpenAI)", async () => {
        await buildService().complete([{role: "user", content: "hi"}], {thinking: "high"});

        const [body] = createMock.mock.calls[0];
        expect(body.reasoning_effort).toBe("high");
        expect(body).not.toHaveProperty("think");
    });

    it("brak thinking → żaden z kluczy nie trafia do body", async () => {
        await buildService().complete([{role: "user", content: "hi"}]);

        const [body] = createMock.mock.calls[0];
        expect(body).not.toHaveProperty("think");
        expect(body).not.toHaveProperty("reasoning_effort");
    });
});

describe("OpenAiConnector — ekstrakcja reasoning z odpowiedzi", () => {
    beforeEach(() => {
        createMock.mockReset();
    });

    it("message.reasoning (rozszerzenie Ollama) → completion.reasoning", async () => {
        createMock.mockResolvedValue(validResponse({
            choices: [{message: {content: "4", reasoning: "We need to compute 2+2."}, finish_reason: "stop"}],
        }));

        const completion = await buildService().complete([{role: "user", content: "hi"}]);

        expect(completion.reasoning).toBe("We need to compute 2+2.");
    });

    it("brak reasoning → completion.reasoning undefined", async () => {
        createMock.mockResolvedValue(validResponse());

        const completion = await buildService().complete([{role: "user", content: "hi"}]);

        expect(completion.reasoning).toBeUndefined();
    });
});
