import {types} from "pg";

/**
 * Global node-pg type parsers.
 *
 * By default node-pg returns `bigint` (int8) columns as strings, because a JS `number`
 * cannot hold the full 64-bit range. Bigint is used exclusively as sequential identity
 * keys, and every model getter (`getId()`, foreign-key getters) is typed `: number`.
 * The mismatch is silent and dangerous: a string id used as a `Map` key or in a `===`
 * comparison never matches its numeric counterpart, so lookups quietly fall through.
 *
 * We fix the whole class at the source by parsing int8 into a `number` — but never at the
 * cost of correctness. See {@link parseInt8AsSafeNumber}.
 */

/**
 * Parses a PostgreSQL int8 (bigint) text value into a JS `number`, or throws if the value
 * cannot be represented exactly.
 *
 * A JS `number` (IEEE-754 double) represents integers exactly only up to
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1). Beyond that, distinct integers collapse onto the
 * same float - which would silently turn an id lookup into a wrong-but-successful match on
 * a different row. Rather than corrupt data, we refuse: any value outside the safe range
 * throws a `RangeError`.
 *
 * For identity sequences this boundary is unreachable in practice (it would require ~9
 * quadrillion rows). If a bigint column is ever repurposed to carry genuine 64-bit values
 * (e.g. snowflake ids, hashes), read it explicitly as text in the query (`SELECT id::text`)
 * so this parser does not apply, and handle it as a string/BigInt at the call site.
 */
export function parseInt8AsSafeNumber(value: string): number {
    const parsed: number = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new RangeError(
            `int8 value "${value}" exceeds the JS safe integer range (2^53 - 1) and cannot be `
            + `represented as a number without losing precision. Read this column as text `
            + `(e.g. "id::text") if it must hold genuine 64-bit values.`,
        );
    }
    return parsed;
}

/**
 * Parses a PostgreSQL `time` (OID 1083) text value into a JS `Date`.
 *
 * node-pg returns `time` columns as strings ("HH:MM:SS" or "HH:MM:SS.ffffff") by default.
 * Models type `time` fields as `Date`, expecting a Date anchored at 1970-01-01 UTC.
 * Without this parser, hydration stores the raw string and later `.toISOString()` /
 * `.getTime()` calls fail. Sub-millisecond fractions are dropped (JS Date has ms
 * resolution); wall-clock `time` has no date component, so the anchor is arbitrary
 * and only the time-of-day matters.
 */
export function parseTimeAsDate(value: string): Date {
    const parts: string[] = value.split(':');
    const hours: number = parseInt(parts[0], 10);
    const minutes: number = parseInt(parts[1], 10);
    const sParts: string[] = (parts[2] ?? '0').split('.');
    const seconds: number = parseInt(sParts[0], 10);
    return new Date(Date.UTC(1970, 0, 1, hours, minutes, seconds));
}

/**
 * Registers the global node-pg type parsers. `setTypeParser` mutates process-wide state,
 * so this must run once before the first query; it is idempotent and safe to call again.
 */
export function registerPgTypeParsers(): void {
    types.setTypeParser(types.builtins.INT8, parseInt8AsSafeNumber);
    types.setTypeParser(types.builtins.TIME, parseTimeAsDate);
}
