import {SecretPaths} from '../../src/utils/SecretPaths';

const TOKEN: string = 'A'.repeat(30) + '_-b';

describe('SecretPaths', () => {
    it('bez rejestracji redact nie zmienia tekstu', () => {
        expect(SecretPaths.redact('/s/' + TOKEN + '/files/1/thumb')).toBe('/s/' + TOKEN + '/files/1/thumb');
    });

    it('po rejestracji maskuje token w ścieżce', () => {
        SecretPaths.register(/\/(s|d)\/[A-Za-z0-9_-]{20,}/g, '/$1/***');
        expect(SecretPaths.redact('/s/' + TOKEN + '/files/1/thumb')).toBe('/s/***/files/1/thumb');
        expect(SecretPaths.redact('/d/' + TOKEN + '/api/submit')).toBe('/d/***/api/submit');
    });

    it('krótkie fragmenty za ścieżką pozostają bez zmian', () => {
        SecretPaths.register(/\/(s|d)\/[A-Za-z0-9_-]{20,}/g, '/$1/***');
        expect(SecretPaths.redact('/s/short/api')).toBe('/s/short/api');
    });
});
