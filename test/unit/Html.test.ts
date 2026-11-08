import {Html} from "../../src/utils/Html";

describe('Html.escape', () => {
    it('escapes the full superset used in text and attributes', () => {
        expect(Html.escape('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    });

    it('escapes ampersands first so entities are not double-decoded', () => {
        expect(Html.escape('&lt;')).toBe('&amp;lt;');
    });

    it('leaves plain text untouched', () => {
        expect(Html.escape('Zażółć gęślą jaźń')).toBe('Zażółć gęślą jaźń');
    });

    it('escapeAttr has the same safe superset', () => {
        expect(Html.escapeAttr('a"b\'c<d>e&f')).toBe('a&quot;b&#39;c&lt;d&gt;e&amp;f');
    });
});
