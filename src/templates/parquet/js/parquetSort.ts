// Pure search / sort / pagination helpers for the Chrome Parquet viewer
// (issue #40).
//
// Kept side-effect-free / DOM-less so the helpers can be unit-tested in
// isolation. The orchestration layer in `parquetViewerMain.ts` wires
// these into the rendered table.
//
// Sort semantics summary:
//   - Three-state cycle per column: asc -> desc -> none. Switching to a
//     different column always restarts at `asc` (matches the CSV viewer's
//     behavior in #33 / `csvSort.ts`, just on row-object data).
//   - Stable: equal-keyed rows fall back to their original index so a
//     re-sort on the same column doesn't shuffle ties.
//   - Type-aware (number vs text only — the issue body asks for numeric
//     vs lexicographic; date-aware sorting is out of scope here):
//       * `null` / `undefined` always sort to the end regardless of
//         direction so empties stay out of the way for both asc and desc
//         sweeps (mirrors the CSV viewer).
//       * Numeric columns: every non-null value either is `bigint`, is a
//         finite `number`, or parses via `Number(...)` to a finite number.
//         Sorted by the numeric value.
//       * Text columns: lexicographic (`localeCompare`, case-insensitive)
//         on `String(value)`.
//
// Filter semantics:
//   - Contains, case-insensitive, across all columns.
//   - Each cell is stringified via `String(value)` per the issue body.
//     `null` / `undefined` stringify to "null" / "undefined" — a literal
//     search for the word "null" therefore matches null cells, which
//     matches the user's mental model of the rendered table.
//   - BigInt values stringify via `String(bi)` -> the decimal digits, so
//     a search for "12345" matches a bigint cell of 12345n.
//   - Object / array cells fall back to `JSON.stringify` (with a BigInt
//     replacer) so a structured cell still searches sensibly. If
//     stringification throws (very rare — circular refs etc.) we fall
//     back to `String(value)` which produces "[object Object]" but at
//     least never throws.
//
// Pagination semantics:
//   - 1-based page index.
//   - Default 200 rows per page (matches Excel viewer's #36 default and
//     the parquet bootstrap slice's PREVIEW_ROW_COUNT).
//   - `applySearch` resets to page 1 (DoD).

export type SortDirection = 'asc' | 'desc' | null;

export interface SortState {
    /** Column key being sorted, or `null` for "no sort". */
    columnKey: string | null;
    direction: SortDirection;
}

export type ColumnType = 'number' | 'text';

export type ParquetRow = Record<string, unknown>;

export const DEFAULT_ROWS_PER_PAGE = 200;

/**
 * Cycle a column's sort direction asc -> desc -> none. Switching to a new
 * column always starts at `asc`.
 */
export function nextSortState(
    current: SortState,
    columnKey: string
): SortState {
    if (current.columnKey !== columnKey) {
        return { columnKey, direction: 'asc' };
    }
    if (current.direction === 'asc') {
        return { columnKey, direction: 'desc' };
    }
    if (current.direction === 'desc') {
        return { columnKey: null, direction: null };
    }
    return { columnKey, direction: 'asc' };
}

/**
 * Test whether `value` is "numeric-coercible": bigint, finite number, or a
 * non-empty string that parses to a finite number. `null` / `undefined`
 * are NOT numeric — they're handled separately as "empties".
 */
function isNumericValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'bigint') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return false;
        const n = Number(trimmed);
        return Number.isFinite(n);
    }
    return false;
}

/**
 * Detect the type of a column from a sample of its values.
 *
 * Rules (evaluated in order):
 *   1. If at least one non-null value exists and ALL non-null values are
 *      numeric (bigint, finite number, or numeric string), the column is
 *      `number`.
 *   2. Otherwise `text`.
 *
 * `null` / `undefined` are skipped for type detection — they always sort
 * to the end regardless of column type.
 */
export function detectColumnType(values: readonly unknown[]): ColumnType {
    let nonNullSeen = 0;
    for (const v of values) {
        if (v === null || v === undefined) continue;
        nonNullSeen++;
        if (!isNumericValue(v)) return 'text';
    }
    if (nonNullSeen === 0) return 'text';
    return 'number';
}

interface NormalizedKey {
    isEmpty: boolean;
    /** number for numeric columns; lowercased string for text columns. */
    key: number | string;
}

/**
 * Convert a raw cell to a stable comparable key according to the chosen
 * column type. `null` / `undefined` flag `isEmpty` so the comparator can
 * push them to the bottom regardless of direction.
 *
 * For numeric columns:
 *   - bigint: convert to Number. Precision loss is possible above
 *     `Number.MAX_SAFE_INTEGER`, but for sort ordering this is acceptable
 *     (the relative ordering of huge ints is preserved up to the boundary
 *     where two bigints map to the same Number — that's a rare case for
 *     real data and the alternative — implementing a bigint-aware
 *     comparator — is significant complexity for marginal value).
 *   - number: pass through (NaN/Infinity are guarded — non-finite values
 *     are treated as empty so they don't poison the sort).
 *   - string: parse via Number; non-finite -> treat as empty.
 *   - other: treat as empty (cannot happen on a verified-numeric column).
 *
 * For text columns we lowercase via `toLocaleLowerCase()` so the compare
 * step is a stable case-insensitive sort.
 */
function normalize(value: unknown, type: ColumnType): NormalizedKey {
    if (value === null || value === undefined) {
        return { isEmpty: true, key: '' };
    }
    if (type === 'number') {
        if (typeof value === 'bigint') {
            return { isEmpty: false, key: Number(value) };
        }
        if (typeof value === 'number') {
            return Number.isFinite(value)
                ? { isEmpty: false, key: value }
                : { isEmpty: true, key: '' };
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return { isEmpty: true, key: '' };
            const n = Number(trimmed);
            return Number.isFinite(n)
                ? { isEmpty: false, key: n }
                : { isEmpty: true, key: '' };
        }
        return { isEmpty: true, key: '' };
    }
    // text column
    const s = stringifyForCompare(value);
    if (s.length === 0) return { isEmpty: true, key: '' };
    return { isEmpty: false, key: s.toLocaleLowerCase() };
}

/**
 * Stringify a value for text-sort comparison. Mirrors `cellToSearchText`
 * but kept separate so each can evolve independently — the search path
 * leans on substring matching while the sort path only cares about
 * locale-stable ordering.
 */
function stringifyForCompare(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value instanceof Uint8Array) {
        // Hex preview — same shape as the renderer's preview so a sort
        // ordering matches what the user sees in the cell. We deliberately
        // drop the byte-count suffix so equal hex prefixes still sort
        // adjacently (rather than splitting on "(123 bytes)").
        return Array.from(value.slice(0, 16))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
    }
    try {
        return JSON.stringify(value, (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v
        ) ?? '';
    } catch {
        return String(value);
    }
}

function compareNormalized(a: NormalizedKey, b: NormalizedKey): number {
    if (a.isEmpty && b.isEmpty) return 0;
    if (a.isEmpty) return 1;
    if (b.isEmpty) return -1;
    if (typeof a.key === 'number' && typeof b.key === 'number') {
        if (a.key < b.key) return -1;
        if (a.key > b.key) return 1;
        return 0;
    }
    return String(a.key).localeCompare(String(b.key), undefined, {
        numeric: true,
        sensitivity: 'base'
    });
}

/**
 * Produce a sorted copy of `rows` according to `state`. The sort is stable
 * (equal-keyed rows preserve their original index order). Returns a fresh
 * array; never mutates the input.
 *
 * When `state.direction` is `null` or `state.columnKey` is `null`, returns
 * a shallow copy of the input — preserving original row order.
 *
 * `columnType` may be passed when the caller has already detected it (the
 * orchestration layer detects once when columns first render, then caches
 * the result keyed by column name). When omitted we sample the column from
 * `rows` and detect on the fly.
 */
export function applySort(
    rows: readonly ParquetRow[],
    state: SortState,
    columnType?: ColumnType
): ParquetRow[] {
    if (state.columnKey === null || !state.direction) {
        return rows.slice();
    }
    const { columnKey, direction } = state;
    const dir = direction === 'asc' ? 1 : -1;
    const type =
        columnType ?? detectColumnType(rows.map((r) => r[columnKey]));

    const decorated = rows.map((row, position) => ({
        row,
        position,
        norm: normalize(row[columnKey], type)
    }));

    decorated.sort((a, b) => {
        // Empties stay at the bottom regardless of direction. The
        // comparator returns +/- without applying `dir` so flipping the
        // sort direction doesn't move empties to the top.
        if (a.norm.isEmpty || b.norm.isEmpty) {
            const cmp = compareNormalized(a.norm, b.norm);
            if (cmp !== 0) return cmp;
            return a.position - b.position;
        }
        const cmp = compareNormalized(a.norm, b.norm);
        if (cmp !== 0) return cmp * dir;
        return a.position - b.position;
    });

    return decorated.map((d) => d.row);
}

// --- Filter helpers ---------------------------------------------------

/**
 * Stringify a cell value for the search-substring check. Per the issue
 * body we use `String(value)` — but we extend that to JSON-stringify
 * structured values so a search for an inner field still matches. The
 * BigInt replacer keeps `JSON.stringify` from throwing on bigint cells.
 */
export function cellToSearchText(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value instanceof Uint8Array) {
        return Array.from(value.slice(0, 16))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
    }
    try {
        return JSON.stringify(value, (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v
        ) ?? String(value);
    } catch {
        return String(value);
    }
}

/**
 * Test whether `row` contains `searchTerm` (case-insensitive) in any
 * column. Empty / whitespace-only search terms always match.
 */
export function rowMatchesSearch(
    row: ParquetRow | undefined | null,
    searchTerm: string
): boolean {
    if (!searchTerm) return true;
    if (!row) return false;
    const needle = searchTerm.toLowerCase();
    for (const key of Object.keys(row)) {
        const text = cellToSearchText(row[key]).toLowerCase();
        if (text.includes(needle)) return true;
    }
    return false;
}

/**
 * Filter `rows` down to those matching `searchTerm`. Returns a fresh
 * array even when the search term is empty (so callers can mutate the
 * result without aliasing the input).
 */
export function filterRows(
    rows: readonly ParquetRow[],
    searchTerm: string
): ParquetRow[] {
    if (!searchTerm) return rows.slice();
    return rows.filter((row) => rowMatchesSearch(row, searchTerm));
}

// --- Pagination helpers ----------------------------------------------

export interface PaginationState {
    page: number;        // 1-based
    rowsPerPage: number; // > 0
    totalRows: number;
}

export interface PageSlice {
    rows: ParquetRow[];
    /** 0-based inclusive */
    startIndex: number;
    /** 0-based exclusive */
    endIndex: number;
}

export function totalPageCount(state: PaginationState): number {
    if (state.totalRows <= 0 || state.rowsPerPage <= 0) return 1;
    return Math.max(1, Math.ceil(state.totalRows / state.rowsPerPage));
}

export function clampPage(state: PaginationState): number {
    const totalPages = totalPageCount(state);
    if (state.page < 1) return 1;
    if (state.page > totalPages) return totalPages;
    return state.page;
}

export function getPageSlice(
    rows: readonly ParquetRow[],
    state: PaginationState
): PageSlice {
    const total = rows.length;
    const stateForClamp: PaginationState = { ...state, totalRows: total };
    const page = clampPage(stateForClamp);
    const startIndex = (page - 1) * state.rowsPerPage;
    const endIndex = Math.min(total, startIndex + state.rowsPerPage);
    return {
        rows: rows.slice(startIndex, endIndex),
        startIndex,
        endIndex
    };
}

export function nextPage(state: PaginationState): PaginationState {
    const totalPages = totalPageCount(state);
    return { ...state, page: Math.min(totalPages, state.page + 1) };
}

export function prevPage(state: PaginationState): PaginationState {
    return { ...state, page: Math.max(1, state.page - 1) };
}

export interface ApplySearchResult {
    filtered: ParquetRow[];
    pagination: PaginationState;
}

/**
 * Run a search and return the filtered set + a fresh pagination state
 * pinned to page 1. DoD: "search reset → page 1".
 */
export function applySearch(
    rows: readonly ParquetRow[],
    searchTerm: string,
    rowsPerPage = DEFAULT_ROWS_PER_PAGE
): ApplySearchResult {
    const filtered = filterRows(rows, searchTerm);
    return {
        filtered,
        pagination: {
            page: 1,
            rowsPerPage,
            totalRows: filtered.length
        }
    };
}
