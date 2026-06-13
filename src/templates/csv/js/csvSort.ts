// CSV column sort utilities (issue #33).
//
// This module is intentionally pure / DOM-less so it can be unit-tested in
// isolation under jsdom. The viewer wires it up to the rendered table.
//
// Sort behavior summary:
//   - Three-state cycle per column: asc -> desc -> none.
//   - Stable: when two values compare equal we fall back to original index.
//   - Type-aware:
//       * empty (""/whitespace) values always sort to the bottom regardless of
//         direction (matches the VSCode reference behavior — keeps "blank"
//         rows out of the way for both asc and desc sweeps).
//       * numeric: a column sample is treated as numeric if every non-empty
//         entry parses with `Number(...)` to a finite value.
//       * date: every non-empty entry parses with `Date.parse(...)` to a
//         finite epoch AND looks date-shaped (contains `-` or `/` or `:`),
//         so we don't accidentally classify "1234" as a date.
//       * otherwise: text (locale-aware, numeric-collation enabled).
//
// Why detect the *column* type instead of comparing pair-by-pair?
//   - It's predictable: a single mixed-type cell can't flip the ordering rule
//     mid-sort.
//   - It's stable across re-renders (the type is recomputed from the same
//     column, so toggling direction doesn't reshuffle).

export type SortDirection = 'asc' | 'desc' | null;

export interface SortState {
    columnIndex: number | null;
    direction: SortDirection;
}

export type ColumnType = 'number' | 'date' | 'text';

/**
 * Cycle a column's sort direction asc -> desc -> none. Switching to a new
 * column always starts at `asc`.
 */
export function nextSortState(
    current: SortState,
    columnIndex: number
): SortState {
    if (current.columnIndex !== columnIndex) {
        return { columnIndex, direction: 'asc' };
    }
    if (current.direction === 'asc') {
        return { columnIndex, direction: 'desc' };
    }
    if (current.direction === 'desc') {
        return { columnIndex: null, direction: null };
    }
    return { columnIndex, direction: 'asc' };
}

const DATE_SHAPE_RE = /[-/:T]/;

/**
 * Detect the type of a column from its values. Empty strings are ignored for
 * type detection — they sort separately at the end.
 *
 * Rules (evaluated in order):
 *   1. If at least one non-empty value exists and ALL non-empty values parse
 *      to finite Number, the column is `number`.
 *   2. Else if at least one non-empty value exists and ALL non-empty values
 *      both look date-shaped AND parse via Date.parse to finite epoch, the
 *      column is `date`.
 *   3. Otherwise `text`.
 */
export function detectColumnType(values: readonly string[]): ColumnType {
    let nonEmpty = 0;
    let allNumeric = true;
    let allDate = true;
    for (const raw of values) {
        const v = (raw ?? '').trim();
        if (!v) continue;
        nonEmpty++;
        if (allNumeric) {
            const n = Number(v);
            if (!Number.isFinite(n)) {
                allNumeric = false;
            }
        }
        if (allDate) {
            if (!DATE_SHAPE_RE.test(v) || !Number.isFinite(Date.parse(v))) {
                allDate = false;
            }
        }
        if (!allNumeric && !allDate) break;
    }
    if (nonEmpty === 0) return 'text';
    if (allNumeric) return 'number';
    if (allDate) return 'date';
    return 'text';
}

interface NormalizedValue {
    isEmpty: boolean;
    /** number for numeric/date columns; lowercased string for text. */
    key: number | string;
}

function normalize(raw: string, type: ColumnType): NormalizedValue {
    const v = (raw ?? '').trim();
    if (!v) return { isEmpty: true, key: '' };
    if (type === 'number') {
        const n = Number(v);
        return Number.isFinite(n)
            ? { isEmpty: false, key: n }
            : { isEmpty: false, key: v.toLocaleLowerCase() };
    }
    if (type === 'date') {
        const ms = Date.parse(v);
        return Number.isFinite(ms)
            ? { isEmpty: false, key: ms }
            : { isEmpty: false, key: v.toLocaleLowerCase() };
    }
    return { isEmpty: false, key: v.toLocaleLowerCase() };
}

function compareNormalized(
    a: NormalizedValue,
    b: NormalizedValue
): number {
    // Empties always go to the bottom.
    if (a.isEmpty && b.isEmpty) return 0;
    if (a.isEmpty) return 1;
    if (b.isEmpty) return -1;

    if (typeof a.key === 'number' && typeof b.key === 'number') {
        if (a.key < b.key) return -1;
        if (a.key > b.key) return 1;
        return 0;
    }
    // Fall back to string locale compare with numeric collation so "10" > "9".
    return String(a.key).localeCompare(String(b.key), undefined, {
        numeric: true,
        sensitivity: 'base'
    });
}

/**
 * Produce a sorted copy of `rowIndices` according to `state` and the column
 * data extracted by `getCell`. The sort is stable: equal pairs preserve
 * relative order via the original index.
 *
 * Returns a fresh array; never mutates the input.
 */
export function applySort(
    rowIndices: readonly number[],
    state: SortState,
    getCell: (rowIndex: number, columnIndex: number) => string,
    columnType?: ColumnType
): number[] {
    if (state.columnIndex === null || !state.direction) {
        return [...rowIndices];
    }
    const { columnIndex, direction } = state;
    const dir = direction === 'asc' ? 1 : -1;

    const type =
        columnType ??
        detectColumnType(rowIndices.map((i) => getCell(i, columnIndex)));

    // Decorate with normalized keys + original position for stable sort.
    const decorated = rowIndices.map((rowIndex, position) => ({
        rowIndex,
        position,
        norm: normalize(getCell(rowIndex, columnIndex), type)
    }));

    decorated.sort((a, b) => {
        // Empty handling is direction-independent: emptys at the end.
        if (a.norm.isEmpty || b.norm.isEmpty) {
            const cmp = compareNormalized(a.norm, b.norm);
            if (cmp !== 0) return cmp;
            return a.position - b.position;
        }
        const cmp = compareNormalized(a.norm, b.norm);
        if (cmp !== 0) return cmp * dir;
        return a.position - b.position;
    });

    return decorated.map((d) => d.rowIndex);
}
