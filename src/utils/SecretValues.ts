const patterns: RegExp[] = [];
const MASK: string = '***';

/**
 * Maskowanie całych wartości parametrów (np. tokenów) w logach diagnostycznych. Wzorce rejestruje
 * aplikacja (composition root) - pusta lista oznacza brak zmian, więc biblioteka pozostaje generyczna.
 */
export class SecretValues {
    public static register(pattern: RegExp): void {
        patterns.push(pattern);
    }

    public static redactValue(value: unknown): unknown {
        if (typeof value !== 'string') {
            return value;
        }
        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            if (pattern.test(value)) {
                return MASK;
            }
        }
        return value;
    }
}

export default SecretValues;
