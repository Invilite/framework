import {SecretValues} from '../../src/utils/SecretValues';

const TOKEN: string = 'A'.repeat(40) + '_-b';

describe('SecretValues', () => {
    it('bez rejestracji redactValue nie zmienia wartości', () => {
        expect(SecretValues.redactValue(TOKEN)).toBe(TOKEN);
        expect(SecretValues.redactValue('/s/' + TOKEN)).toBe('/s/' + TOKEN);
    });

    it('po rejestracji maskuje całą wartość pasującą do wzorca', () => {
        SecretValues.register(/^[A-Za-z0-9_-]{43}$/);

        expect(SecretValues.redactValue(TOKEN)).toBe('***');
    });

    it('nie maskuje wartości, w których wzorzec pasuje tylko do fragmentu', () => {
        SecretValues.register(/^[A-Za-z0-9_-]{43}$/);

        expect(SecretValues.redactValue('/s/' + TOKEN)).toBe('/s/' + TOKEN);
        expect(SecretValues.redactValue(TOKEN + 'x')).toBe(TOKEN + 'x');
    });

    it('nie maskuje wartości innych typów niż string', () => {
        SecretValues.register(/^[A-Za-z0-9_-]{43}$/);
        const date: Date = new Date('2026-10-28T00:00:00Z');
        const object: {token: string} = {token: TOKEN};

        expect(SecretValues.redactValue(42)).toBe(42);
        expect(SecretValues.redactValue(null)).toBeNull();
        expect(SecretValues.redactValue(date)).toBe(date);
        expect(SecretValues.redactValue(object)).toBe(object);
    });
});
