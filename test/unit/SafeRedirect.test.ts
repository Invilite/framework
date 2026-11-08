import {SafeRedirect} from "../../src/utils/SafeRedirect";

describe('SafeRedirect.localPath', () => {
    it.each([
        ['/home', '/home'],
        ['/u/alice?tab=photos#top', '/u/alice?tab=photos#top'],
        ['/a/../b', '/b'],
    ])('local path %s -> %s', (value: string, expected: string): void => {
        expect(SafeRedirect.localPath(value, '/fallback')).toBe(expected);
    });

    it.each([
        ['another host', 'https://evil.com/'],
        ['protocol-relative', '//evil.com'],
        ['backslash trick', '/\\evil.com'],
        ['javascript scheme', 'javascript:alert(1)'],
        ['tab before a slash (stripped by URL parsers)', '/\t/evil.com'],
        ['newline', '/home\n'],
        ['relative path', 'home'],
        ['empty string', ''],
        ['not a string', ['/home']],
        ['undefined', undefined],
        ['dot segment before a protocol-relative path', '/..//evil.com/x'],
        ['current-directory segment before a protocol-relative path', '/.//evil.com'],
        ['parent segment after a directory', '/x/..//evil.com'],
        ['percent-encoded dot segment', '/%2e%2e//evil.com'],
        ['dot segment with two backslashes', '/..\\\\evil.com'],
    ])('%s -> fallback', (_label: string, value: unknown): void => {
        expect(SafeRedirect.localPath(value, '/fallback')).toBe('/fallback');
    });
});
