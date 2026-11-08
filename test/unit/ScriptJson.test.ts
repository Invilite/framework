import {ScriptJson} from "../../src/utils";

describe('ScriptJson.serialize', (): void => {
    it('escapuje < jako \\u003c (breakout </script>)', (): void => {
        const raw: string = ScriptJson.serialize({description: 'a < b </script>'});

        expect(raw).not.toContain('<');
        expect(raw).toContain('a \\u003c b \\u003c/script>');
        expect(JSON.parse(raw).description).toBe('a < b </script>');
    });

    it('round-trip: parse odtwarza oryginalne wartości', (): void => {
        const value: Record<string, unknown> = {
            text: 'Zdjęcie <b>bold</b> & "cytat"',
            nested: {html: '<img src=x onerror=alert(1)>'},
            array: ['<', '>', 42, null],
        };

        expect(JSON.parse(ScriptJson.serialize(value))).toEqual(value);
    });

    it('nie modyfikuje znaków innych niż <', (): void => {
        const raw: string = ScriptJson.serialize({text: 'a > b & c'});

        expect(raw).toContain('a > b & c');
    });
});