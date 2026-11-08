jest.mock("axios", () => {
    const post: jest.Mock = jest.fn();
    const get: jest.Mock = jest.fn();

    class MockAxiosError extends Error {
        public isAxiosError = true;
        public response: {status: number; data?: unknown};
        public constructor(status: number | undefined, message: string = "axios error", public readonly code?: string, data?: unknown) {
            super(message);
            this.response = {status: status ?? 0, data};
        }
    }

    return {
        __esModule: true,
        default: {
            post,
            get,
            isAxiosError: (error: unknown): boolean => (error as {isAxiosError?: boolean})?.isAxiosError === true,
        },
        __MockAxiosError: MockAxiosError,
    };
});

import axios from "axios";
import {inspect} from "util";
import OllamaConnector from "../../src/services/Ollama/OllamaConnector";
import {OllamaConnectorConfig} from "../../src/services/Ollama/OllamaConnector";
import {
    AiAuthError,
    AiImageTooLargeError,
    AiInvalidResponseError,
    AiModelError,
    AiProviderUnavailableError,
    AiRateLimitError,
    AiTimeoutError,
} from "../../src/services/OpenAi/OpenAiErrors";
import {OllamaDecisionQuestions} from "../../src/services/Ollama/OllamaDecisionTypes";
import {AbstractLogger} from "../../src/types/interfaces/AbstractLogger";

const axiosPost: jest.Mock = (axios as any).post;
const axiosGet: jest.Mock = (axios as any).get;
const MockAxiosError: new (status: number | undefined, message?: string, code?: string, data?: unknown) => Error =
    (require("axios") as any).__MockAxiosError;

const loggerStub: AbstractLogger = {
    trace: (): void => {}, debug: (): void => {}, info: (): void => {}, notice: (): void => {},
    warning: (): void => {}, error: (): void => {}, critical: (): void => {}, alert: (): void => {},
    emergency: (): void => {},
};

function buildConnector(config: Partial<OllamaConnectorConfig> = {}): OllamaConnector {
    return new OllamaConnector({
        apiKey: "test-key",
        model: "test-model",
        timeout: 5_000,
        ...config,
    }, loggerStub);
}

function nativeResponse(overrides: object = {}): {data: object} {
    return {data: {
        message: {content: "hello"},
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 5,
        ...overrides,
    }};
}

describe("OllamaConnector — budowa body natywnego API", () => {
    beforeEach(() => {
        axiosPost.mockReset();
        axiosGet.mockReset();
        axiosPost.mockResolvedValue(nativeResponse());
    });

    it("wiadomość tekstowa → body bez images, stream=false", async () => {
        await buildConnector().complete([{role: "user", content: "hi"}]);

        const [url, body] = axiosPost.mock.calls[0];
        expect(url).toBe("https://ollama.com/api/chat");
        expect(body.model).toBe("test-model");
        expect(body.stream).toBe(false);
        expect(body.messages).toEqual([{role: "user", content: "hi"}]);
        expect(body).not.toHaveProperty("images");
    });

    it("thinking:false → body.think=false; brak thinking → brak klucza", async () => {
        await buildConnector().complete([{role: "user", content: "hi"}], {thinking: false});
        expect(axiosPost.mock.calls[0][1].think).toBe(false);

        axiosPost.mockClear();
        await buildConnector().complete([{role: "user", content: "hi"}]);
        expect(axiosPost.mock.calls[0][1]).not.toHaveProperty("think");
    });

    it("thinking jako string ('low'/'medium'/'high') → rzucane, nie cicho coerowane", async () => {
        await expect(buildConnector().complete([{role: "user", content: "hi"}], {thinking: "high"}))
            .rejects.toThrow(/boolean thinking/);
        expect(axiosPost).not.toHaveBeenCalled();
    });

    it("per-request maxImageBytes nadpisuje limit instancji", async () => {
        await expect(buildConnector().complete([{
            role: "user",
            content: [{type: "image", image: {kind: "buffer", data: Buffer.from("abcdef"), mime: "image/png"}}],
        }], {maxImageBytes: 2})).rejects.toBeInstanceOf(AiImageTooLargeError);

        expect(axiosPost).not.toHaveBeenCalled();
    });

    it("format json → body.format; maxTokens → options.num_predict; temperature → options.temperature", async () => {
        await buildConnector().complete([{role: "user", content: "hi"}], {
            format: "json", maxTokens: 77, temperature: 0,
        });

        const body = axiosPost.mock.calls[0][1];
        expect(body.format).toBe("json");
        expect(body.options).toEqual({num_predict: 77, temperature: 0});
    });

    it("części tekst+obraz(buffer) → content złączone, images=[base64]", async () => {
        await buildConnector().complete([{
            role: "user",
            content: [
                {type: "text", text: "co to?"},
                {type: "image", image: {kind: "buffer", data: Buffer.from("abc"), mime: "image/jpeg"}},
            ],
        }]);

        const body = axiosPost.mock.calls[0][1];
        expect(body.messages[0].content).toBe("co to?");
        expect(body.messages[0].images).toEqual([Buffer.from("abc").toString("base64")]);
    });

    it("obraz url → connector fetchuje i inline'uje jako base64 (natywne API nie ma URL-i)", async () => {
        axiosGet.mockResolvedValue({data: Buffer.from("fetched")});

        await buildConnector().complete([{
            role: "user",
            content: [{type: "image", image: {kind: "url", url: "http://seaweed/img.jpg", mime: "image/jpeg"}}],
        }]);

        expect(axiosGet).toHaveBeenCalledWith("http://seaweed/img.jpg", expect.objectContaining({
            responseType: "arraybuffer",
        }));
        expect(axiosPost.mock.calls[0][1].messages[0].images).toEqual([Buffer.from("fetched").toString("base64")]);
    });

    it("obraz ponad limit → AiImageTooLargeError przed requestem", async () => {
        await expect(buildConnector({maxImageBytes: 2}).complete([{
            role: "user",
            content: [{type: "image", image: {kind: "buffer", data: Buffer.from("abcdef"), mime: "image/png"}}],
        }])).rejects.toBeInstanceOf(AiImageTooLargeError);

        expect(axiosPost).not.toHaveBeenCalled();
    });
});

describe("OllamaConnector — parsowanie odpowiedzi", () => {
    beforeEach(() => {
        axiosPost.mockReset();
    });

    it("content → text, thinking → reasoning, eval_count → usage", async () => {
        axiosPost.mockResolvedValue(nativeResponse({
            message: {content: "4", thinking: "Liczę 2+2."},
            done_reason: "stop",
            prompt_eval_count: 12,
            eval_count: 3,
        }));

        const completion = await buildConnector().complete([{role: "user", content: "hi"}]);

        expect(completion).toEqual({
            text: "4",
            reasoning: "Liczę 2+2.",
            finishReason: "stop",
            usage: {promptTokens: 12, completionTokens: 3, totalTokens: 15},
            model: "test-model",
        });
    });

    it("done_reason=length → finishReason length; puste thinking → reasoning undefined", async () => {
        axiosPost.mockResolvedValue(nativeResponse({
            message: {content: "ucięte", thinking: ""},
            done_reason: "length",
        }));

        const completion = await buildConnector().complete([{role: "user", content: "hi"}]);

        expect(completion.finishReason).toBe("length");
        expect(completion.reasoning).toBeUndefined();
    });

    it("brak content → AiInvalidResponseError", async () => {
        axiosPost.mockResolvedValue({data: {message: {}, done_reason: "stop"}});

        await expect(buildConnector().complete([{role: "user", content: "hi"}]))
            .rejects.toBeInstanceOf(AiInvalidResponseError);
    });
});

describe("OllamaConnector — mapowanie błędów HTTP", () => {
    beforeEach(() => {
        axiosPost.mockReset();
    });

    it.each([
        [401, AiAuthError],
        [404, AiModelError],
        [429, AiRateLimitError],
        [500, AiProviderUnavailableError],
    ])("HTTP %i → %p", async (status: number, expected: any) => {
        axiosPost.mockRejectedValue(new MockAxiosError(status, "boom"));

        await expect(buildConnector().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(expected);
    });

    it("HTTP 400 „does not support chat” (model decyzyjny w complete) → AiModelError", async () => {
        axiosPost.mockRejectedValue(new MockAxiosError(400, "boom", undefined, {error: "\"clef\" does not support chat"}));

        await expect(buildConnector().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiModelError);
    });

    it("HTTP 400 z innym błędem → AiInvalidResponseError", async () => {
        axiosPost.mockRejectedValue(new MockAxiosError(400, "boom", undefined, {error: "invalid request"}));

        await expect(buildConnector().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiInvalidResponseError);
    });

    it("timeout (ECONNABORTED) → AiTimeoutError", async () => {
        axiosPost.mockRejectedValue(new MockAxiosError(undefined, "timeout of 5000ms exceeded", "ECONNABORTED"));

        await expect(buildConnector().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiTimeoutError);
    });

    it("błąd nie-axiosowy → AiProviderUnavailableError (defensywnie)", async () => {
        axiosPost.mockRejectedValue(new Error("anything"));

        await expect(buildConnector().complete([{role: "user", content: "hi"}])).rejects.toBeInstanceOf(AiProviderUnavailableError);
    });
});

describe("OllamaConnector — konstruktor (inwarianty)", () => {
    it("pusty model/apiKey rzuca; name domyślnie = model", () => {
        expect(() => buildConnector({model: ""})).toThrow(/non-empty model/);
        expect(() => buildConnector({apiKey: ""})).toThrow(/non-empty apiKey/);
        expect(buildConnector({model: "kimi"}).name).toBe("kimi");
        expect(buildConnector({model: "kimi", name: "photo-search"}).name).toBe("photo-search");
    });
});
function decisionResponse(overrides: object = {}): {data: object} {
    return {data: {
        model: "clef",
        answers: {
            harm: {type: "noul", noul: 0.93},
        },
        usage: {input_tokens: 120, output_tokens: 0},
        ...overrides,
    }};
}

const harmQuestion = {
    harm: {type: "noul", instructions: "Could this tool call cause harm?"},
} satisfies OllamaDecisionQuestions;

function questionsNamed(count: number): OllamaDecisionQuestions {
    const questions: OllamaDecisionQuestions = {};
    for (let i = 0; i < count; i++) {
        questions[`q${i}`] = {type: "noul", instructions: "?"};
    }

    return questions;
}

describe("OllamaConnector.decide — budowa body /v1/systemone", () => {
    beforeEach(() => {
        axiosPost.mockReset();
        axiosGet.mockReset();
        axiosPost.mockResolvedValue(decisionResponse());
    });

    it("POST na /v1/systemone z model, state, questions; bez images, z kluczem w Bearer", async () => {
        await buildConnector({model: "clef"}).decide("send_email(to=\"all\")", harmQuestion);

        const [url, body, config] = axiosPost.mock.calls[0];
        expect(url).toBe("https://ollama.com/v1/systemone");
        expect(body).toEqual({model: "clef", state: "send_email(to=\"all\")", questions: harmQuestion});
        expect(config).toEqual(expect.objectContaining({
            headers: {Authorization: "Bearer test-key"},
            timeout: 5_000,
        }));
    });

    it("state jako obiekt JSON idzie bez zmian; options.model i timeout nadpisują instancję", async () => {
        await buildConnector({baseURL: "http://127.0.0.1:11434/"}).decide(
            {ticket: "I was charged twice."}, harmQuestion, {model: "clef-flash:9b", timeout: 1_000},
        );

        const [url, body, config] = axiosPost.mock.calls[0];
        expect(url).toBe("http://127.0.0.1:11434/v1/systemone");
        expect(body.model).toBe("clef-flash:9b");
        expect(body.state).toEqual({ticket: "I was charged twice."});
        expect(config.timeout).toBe(1_000);
    });

    it("obrazy (buffer, url) → images=[base64] w kolejności żądania", async () => {
        axiosGet.mockResolvedValue({data: Buffer.from("fetched")});

        await buildConnector().decide("receipt", harmQuestion, {images: [
            {kind: "buffer", data: Buffer.from("abc"), mime: "image/png"},
            {kind: "url", url: "http://seaweed/img.jpg", mime: "image/jpeg"},
        ]});

        expect(axiosPost.mock.calls[0][1].images).toEqual([
            Buffer.from("abc").toString("base64"),
            Buffer.from("fetched").toString("base64"),
        ]);
    });
});

describe("OllamaConnector.decide — limity obrazów (chmura: 4 szt., 4 MiB każdy, 8 MiB razem)", () => {
    const MiB: number = 1024 * 1024;
    const png = (bytes: number) => ({kind: "buffer" as const, data: Buffer.alloc(bytes), mime: "image/png"});

    beforeEach(() => {
        axiosPost.mockReset();
        axiosPost.mockResolvedValue(decisionResponse());
    });

    it("piąty obraz → AiImageTooLargeError przed requestem", async () => {
        await expect(buildConnector().decide("x", harmQuestion, {images: [png(1), png(1), png(1), png(1), png(1)]}))
            .rejects.toBeInstanceOf(AiImageTooLargeError);
        expect(axiosPost).not.toHaveBeenCalled();
    });

    it("obraz ponad 4 MiB → AiImageTooLargeError, mimo większego limitu instancji dla czatu", async () => {
        await expect(buildConnector({maxImageBytes: 20 * MiB}).decide("x", harmQuestion, {images: [png(4 * MiB + 1)]}))
            .rejects.toBeInstanceOf(AiImageTooLargeError);
        expect(axiosPost).not.toHaveBeenCalled();
    });

    it("razem ponad 8 MiB → AiImageTooLargeError", async () => {
        await expect(buildConnector().decide("x", harmQuestion, {images: [png(3 * MiB), png(3 * MiB), png(3 * MiB)]}))
            .rejects.toBeInstanceOf(AiImageTooLargeError);
        expect(axiosPost).not.toHaveBeenCalled();
    });

    it("per-request maxImageBytes nadpisuje limit pojedynczego obrazu", async () => {
        await expect(buildConnector().decide("x", harmQuestion, {images: [png(10)], maxImageBytes: 5}))
            .rejects.toBeInstanceOf(AiImageTooLargeError);
        expect(axiosPost).not.toHaveBeenCalled();
    });
});

describe("OllamaConnector.decide — walidacja pytań przed requestem", () => {
    beforeEach(() => {
        axiosPost.mockReset();
    });

    it.each<[string, OllamaDecisionQuestions, RegExp]>([
        ["brak pytań", questionsNamed(0), /1 to 64 questions/],
        ["65 pytań", questionsNamed(65), /1 to 64 questions/],
        ["nazwa ze spacją", {"bad name": {type: "noul", instructions: "?"}}, /Invalid question name/],
        ["nazwa dłuższa niż 100 znaków", {["a".repeat(101)]: {type: "noul", instructions: "?"}}, /Invalid question name/],
        ["choice z jedną opcją", {c: {type: "choice", instructions: "?", criteria: {only: null}}}, /at least 2 options/],
        ["score z jednym poziomem", {s: {type: "score", instructions: "?", criteria: ["low"]}}, /2 to 10 levels/],
        ["score z 11 poziomami", {s: {type: "score", instructions: "?", criteria: Array(11).fill("l")}}, /2 to 10 levels/],
    ])("%s → rzuca", async (_label: string, questions: OllamaDecisionQuestions, message: RegExp) => {
        await expect(buildConnector().decide("x", questions)).rejects.toThrow(message);
        expect(axiosPost).not.toHaveBeenCalled();
    });
});

describe("OllamaConnector.decide — parsowanie odpowiedzi", () => {
    const allTypes = {
        team: {type: "choice", instructions: "Which team?", criteria: {billing: "Payments", other: null}},
        refund: {type: "noul", instructions: "Refund requested?"},
        urgency: {type: "score", instructions: "How urgent?", criteria: ["Routine", "Urgent"]},
    } satisfies OllamaDecisionQuestions;

    const allAnswers = {
        team: {type: "choice", choice: "billing", probabilities: {billing: 0.98, other: 0.02}, confidence: 0.96},
        refund: {type: "noul", noul: 0.99},
        urgency: {type: "score", score: 0.7, legend: {"0": "Routine", "1": "Urgent"}, probabilities: {"0": 0.3, "1": 0.7}, confidence: 0.4},
    };

    beforeEach(() => {
        axiosPost.mockReset();
    });

    it("answers typowane per pytanie, usage.input_tokens → inputTokens, model = żądany", async () => {
        axiosPost.mockResolvedValue(decisionResponse({answers: allAnswers}));

        const decision = await buildConnector({model: "clef"}).decide("ticket", allTypes);

        expect(decision).toEqual({answers: allAnswers, usage: {inputTokens: 120}, model: "clef"});
        const refund: number = decision.answers.refund.noul;
        const team: string = decision.answers.team.choice;
        const urgency: number = decision.answers.urgency.score;
        expect([refund, team, urgency]).toEqual([0.99, "billing", 0.7]);
    });

    it("odpowiedzi spoza zadanych pytań są pomijane", async () => {
        axiosPost.mockResolvedValue(decisionResponse({answers: {harm: {type: "noul", noul: 0.5}, extra: {type: "noul", noul: 1}}}));

        const decision = await buildConnector().decide("x", harmQuestion);

        expect(Object.keys(decision.answers)).toEqual(["harm"]);
    });

    it.each([
        ["brak answers", {answers: undefined}],
        ["brak odpowiedzi na pytanie", {answers: {}}],
        ["typ odpowiedzi ≠ typ pytania", {answers: {harm: {type: "choice", choice: "yes", probabilities: {}, confidence: 1}}}],
        ["noul nie jest liczbą", {answers: {harm: {type: "noul", noul: "0.9"}}}],
    ])("%s → AiInvalidResponseError", async (_label: string, overrides: object) => {
        axiosPost.mockResolvedValue(decisionResponse(overrides));

        await expect(buildConnector().decide("x", harmQuestion)).rejects.toBeInstanceOf(AiInvalidResponseError);
    });

    it.each([
        ["choice bez probabilities", {team: {...allAnswers.team, probabilities: undefined}}],
        ["score bez liczby", {urgency: {...allAnswers.urgency, score: null}}],
    ])("%s → AiInvalidResponseError", async (_label: string, broken: object) => {
        axiosPost.mockResolvedValue(decisionResponse({answers: {...allAnswers, ...broken}}));

        await expect(buildConnector().decide("x", allTypes)).rejects.toBeInstanceOf(AiInvalidResponseError);
    });
});

describe("OllamaConnector.decide — mapowanie błędów HTTP", () => {
    beforeEach(() => {
        axiosPost.mockReset();
    });

    it("HTTP 400 „is not a llama.cpp decision model” (model czatowy w decide) → AiModelError", async () => {
        axiosPost.mockRejectedValue(new MockAxiosError(400, "boom", undefined, {error: "model \"gemma4:e2b\" is not a llama.cpp decision model"}));

        await expect(buildConnector().decide("x", harmQuestion)).rejects.toBeInstanceOf(AiModelError);
    });

    it.each([
        [401, AiAuthError],
        [429, AiRateLimitError],
        [503, AiProviderUnavailableError],
    ])("HTTP %i → %p", async (status: number, expected: new (...args: never[]) => Error) => {
        axiosPost.mockRejectedValue(new MockAxiosError(status, "boom"));

        await expect(buildConnector().decide("x", harmQuestion)).rejects.toBeInstanceOf(expected);
    });
});


describe("OllamaConnector - error cause sanitization", () => {
    beforeEach(() => {
        axiosPost.mockReset();
        axiosGet.mockReset();
    });

    function axiosErrorWithSecrets(status: number): Error {
        const error: Error & {isAxiosError: boolean; config: unknown} =
            new MockAxiosError(status, "request failed") as Error & {isAxiosError: boolean; config: unknown};
        error.config = {
            headers: {Authorization: "Bearer test-key"},
            data: {prompt: "secret-prompt", image: "secret-image"},
        };
        return error;
    }

    async function capture(promise: Promise<unknown>): Promise<unknown> {
        try {
            await promise;
        } catch (error: unknown) {
            return error;
        }
        throw new Error("Expected the promise to reject");
    }

    function expectNoSecrets(thrown: unknown): void {
        const serialized: string = JSON.stringify(thrown);
        const inspected: string = inspect(thrown, {depth: null});

        expect(serialized).not.toContain("test-key");
        expect(inspected).not.toContain("test-key");
        expect(inspected).not.toContain("secret-prompt");
        expect(inspected).not.toContain("secret-image");
    }

    it("does not expose the API key when complete() maps an axios error", async () => {
        axiosPost.mockRejectedValue(axiosErrorWithSecrets(401));

        const thrown: unknown = await capture(buildConnector().complete([{role: "user", content: "hi"}]));

        expect(thrown).toBeInstanceOf(AiAuthError);
        expectNoSecrets(thrown);
    });

    it("does not expose the API key when decide() maps an axios error", async () => {
        axiosPost.mockRejectedValue(axiosErrorWithSecrets(429));

        const thrown: unknown = await capture(buildConnector().decide("x", harmQuestion));

        expect(thrown).toBeInstanceOf(AiRateLimitError);
        expectNoSecrets(thrown);
    });

    it("does not expose headers when fetching an image fails", async () => {
        axiosGet.mockRejectedValue(axiosErrorWithSecrets(500));

        const thrown: unknown = await capture(buildConnector().complete([{
            role: "user",
            content: [{type: "image", image: {kind: "url", url: "http://seaweed/img.jpg", mime: "image/jpeg"}}],
        }]));

        expect(thrown).toBeInstanceOf(AiProviderUnavailableError);
        expectNoSecrets(thrown);
    });
});
