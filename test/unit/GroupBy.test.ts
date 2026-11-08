import {groupBy} from "../../src/utils/GroupBy";

describe('groupBy', () => {
    it('groups rows preserving their order inside each group', () => {
        const rows = [
            {messageId: 2, id: 1},
            {messageId: 1, id: 2},
            {messageId: 2, id: 3},
        ];

        const grouped: Map<number, number[]> = groupBy(
            rows,
            (row): number => row.messageId,
            (row): number => row.id,
        );

        expect([...grouped.keys()]).toEqual([2, 1]);
        expect(grouped.get(2)).toEqual([1, 3]);
        expect(grouped.get(1)).toEqual([2]);
    });

    it('returns an empty map for no rows', () => {
        expect(groupBy([], (row: number): number => row, (row: number): number => row).size).toBe(0);
    });
});
