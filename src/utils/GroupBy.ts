/**
 * Groups already-ordered rows into `Map<key, items[]>` preserving row order inside each group.
 */
export function groupBy<Row, Item, Key extends number | string>(
    rows: readonly Row[],
    keyOf: (row: Row) => Key,
    map: (row: Row) => Item,
): Map<Key, Item[]> {
    const result: Map<Key, Item[]> = new Map<Key, Item[]>();

    for (const row of rows) {
        const key: Key = keyOf(row);
        const list: Item[] = result.get(key) ?? [];
        list.push(map(row));
        result.set(key, list);
    }

    return result;
}
