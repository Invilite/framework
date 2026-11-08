import {DateTime} from "../../src/utils/DateTime";

describe('DateTime.monthGenitive', () => {
    it('uses 0-based months like Date.getMonth()', () => {
        expect(DateTime.monthGenitive(0)).toBe('stycznia');
        expect(DateTime.monthGenitive(2)).toBe('marca');
        expect(DateTime.monthGenitive(11)).toBe('grudnia');
    });
});
