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
} from "../../src/services/OpenAi/OpenAiErrors";

describe("OpenAiErrors — taksonomia", () => {
    it("baza przenosi instance, retryable i cause", () => {
        const cause: Error = new Error("socket hang up");
        const error: AiConnectorError = new AiConnectorError("boom", "ollama", true, cause);

        expect(error).toBeInstanceOf(Error);
        expect(error.instance).toBe("ollama");
        expect(error.retryable).toBe(true);
        expect(error.cause).toBe(cause);
        expect(error.message).toBe("boom");
    });

    it("flaga retryable jest zaszyta na stałe per typ (kontrakt dla consumerów)", () => {
        expect(new AiProviderUnavailableError("m", "x").retryable).toBe(true);
        expect(new AiTimeoutError("m", "x").retryable).toBe(true);
        expect(new AiRateLimitError("m", "x").retryable).toBe(true);
        expect(new AiModelError("m", "x").retryable).toBe(false);
        expect(new AiAuthError("m", "x").retryable).toBe(false);
        expect(new AiContentFilterError("m", "x").retryable).toBe(false);
        expect(new AiInvalidResponseError("m", "x").retryable).toBe(false);
        expect(new AiImageTooLargeError("m", "x").retryable).toBe(false);
    });

    it("name wskazuje konkretną podklasę, nie bazę (czytelne w logach)", () => {
        const error: AiModelError = new AiModelError("model not found", "ollama");

        expect(error.name).toBe("AiModelError");
        expect(error).toBeInstanceOf(AiConnectorError);
    });
});
