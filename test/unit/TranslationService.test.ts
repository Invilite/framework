import TranslationService from "../../src/services/TranslationService";

describe('TranslationService', () => {
    afterEach((): void => {
        TranslationService.clear();
    });

    test('returns undefined for an unregistered code', (): void => {
        expect(TranslationService.forZodError('too_small')).toBeUndefined();
    });

    test('returns a registered message', (): void => {
        TranslationService.register({too_small: 'A'});

        expect(TranslationService.forZodError('too_small')).toBe('A');
    });

    test('the same key overwrites the previous message', (): void => {
        TranslationService.register({too_small: 'A'});
        TranslationService.register({too_small: 'B'});

        expect(TranslationService.forZodError('too_small')).toBe('B');
    });

    test('clear removes all registered messages', (): void => {
        TranslationService.register({too_small: 'A'});
        TranslationService.clear();

        expect(TranslationService.forZodError('too_small')).toBeUndefined();
    });
});
