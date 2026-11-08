const translations: Map<string, string> = new Map<string, string>();

export default class TranslationService {
    public static register(messages: Readonly<Record<string, string>>): void {
        for (const [code, message] of Object.entries(messages)) {
            translations.set(code, message);
        }
    }

    public static forZodError(code: string): string | undefined {
        return translations.get(code);
    }

    public static clear(): void {
        translations.clear();
    }
}
