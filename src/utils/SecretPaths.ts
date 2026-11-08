interface SecretPattern {
    pattern: RegExp;
    replacement: string;
}

const patterns: SecretPattern[] = [];

/**
 * Maskowanie poufnych fragmentów ścieżek i adresów w logach oraz zdarzeniach błędów. Wzorce rejestruje
 * aplikacja (composition root) - pusta lista oznacza brak zmian, więc biblioteka pozostaje generyczna.
 */
export class SecretPaths {
    public static register(pattern: RegExp, replacement: string): void {
        patterns.push({pattern, replacement});
    }

    public static redact(text: string): string {
        let redacted: string = text;
        for (const secretPattern of patterns) {
            redacted = redacted.replace(secretPattern.pattern, secretPattern.replacement);
        }
        return redacted;
    }
}

export default SecretPaths;
