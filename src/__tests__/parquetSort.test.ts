// Unit tests for the Parquet search / sort / pagination helpers
// (issue #40).
//
// Covers:
//   - 3-state cycle: asc -> desc -> none, switching columns resets to asc.
//   - Type detection: numeric (number / bigint / numeric-string),
//     fallback to text.
//   - Stable sort: equal keys preserve their original relative order (the
//     issue body's "stable sort with original-index tiebreaker").
//   - Numeric sort: 10 > 9 (compares as number, not string).
//   - Text sort: locale-aware, case-insensitive.
//   - Null / undefined cells always sort to the end (asc and desc).
//   - Search: case-insensitive contains across all columns via String(value).
//   - Pagination: 1-based, default 200/page, prev/next clamps.
//   - applySearch resets pagination to page 1.

import {
    applySearch,
    applySort,
    cellToSearchText,
    clampPage,
    DEFAULT_ROWS_PER_PAGE,
    detectColumnType,
    filterRows,
    getPageSlice,
    nextPage,
    nextSortState,
    prevPage,
    rowMatchesSearch,
    totalPageCount,
    type ParquetRow,
    type SortState
} from '../templates/parquet/js/parquetSort';

// --- nextSortState ----------------------------------------------------

describe('nextSortState', () => {
    const NONE: SortState = { columnKey: null, direction: null };

    it('starts at asc when no column is sorted', () => {
        expect(nextSortState(NONE, 'name')).toEqual({
            columnKey: 'name',
            direction: 'asc'
        });
    });

    it('cycles asc -> desc on the same column', () => {
        const after = nextSortState(
            { columnKey: 'price', direction: 'asc' },
            'price'
        );
        expect(after).toEqual({ columnKey: 'price', direction: 'desc' });
    });

    it('cycles desc -> none on the same column', () => {
        const after = nextSortState(
            { columnKey: 'price', direction: 'desc' },
            'price'
        );
        expect(after).toEqual({ columnKey: null, direction: null });
    });

    it('cycles none -> asc on the same column', () => {
        const after = nextSortState(NONE, 'qty');
        expect(after).toEqual({ columnKey: 'qty', direction: 'asc' });
    });

    it('clicking a different column resets to asc on that column', () => {
        const after = nextSortState(
            { columnKey: 'name', direction: 'desc' },
            'price'
        );
        expect(after).toEqual({ columnKey: 'price', direction: 'asc' });
    });

    it('completes a full asc->desc->none cycle', () => {
        let state: SortState = NONE;
        state = nextSortState(state, 'col');
        expect(state.direction).toBe('asc');
        state = nextSortState(state, 'col');
        expect(state.direction).toBe('desc');
        state = nextSortState(state, 'col');
        expect(state).toEqual(NONE);
    });
});

// --- detectColumnType -------------------------------------------------

describe('detectColumnType', () => {
    it('detects a column of numbers as number', () => {
        expect(detectColumnType([1, 42, 7])).toBe('number');
    });

    it('detects a column of bigints as number', () => {
        expect(detectColumnType([1n, 2n, 3n])).toBe('number');
    });

    it('detects a column of numeric strings as number', () => {
        expect(detectColumnType(['10', '2.5', '-3', '4e2'])).toBe('number');
    });

    it('treats null / undefined as not type-defining', () => {
        expect(detectColumnType([null, 1, undefined, 2])).toBe('number');
        expect(detectColumnType([null, null, undefined])).toBe('text');
    });

    it('falls back to text for mixed numeric + alpha', () => {
        expect(detectColumnType([1, 'two', 3])).toBe('text');
    });

    it('falls back to text on any non-numeric string', () => {
        expect(detectColumnType(['10', 'abc', '3'])).toBe('text');
    });

    it('treats booleans as text', () => {
        expect(detectColumnType([true, false, true])).toBe('text');
    });

    it('returns text for an empty column', () => {
        expect(detectColumnType([])).toBe('text');
    });
});

// --- applySort: numeric ------------------------------------------------

describe('applySort — numeric', () => {
    const rows: ParquetRow[] = [
        { name: 'a', value: 10 },
        { name: 'b', value: 2 },
        { name: 'c', value: 11 },
        { name: 'd', value: 1 }
    ];

    it('sorts numerically ascending (not lexicographically)', () => {
        const sorted = applySort(rows, {
            columnKey: 'value',
            direction: 'asc'
        });
        // 1, 2, 10, 11 -> rows d, b, a, c
        expect(sorted.map((r) => r.name)).toEqual(['d', 'b', 'a', 'c']);
    });

    it('sorts numerically descending', () => {
        const sorted = applySort(rows, {
            columnKey: 'value',
            direction: 'desc'
        });
        // 11, 10, 2, 1 -> c, a, b, d
        expect(sorted.map((r) => r.name)).toEqual(['c', 'a', 'b', 'd']);
    });

    it('returns a copy unchanged when direction is null', () => {
        const sorted = applySort(rows, {
            columnKey: null,
            direction: null
        });
        expect(sorted.map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
        // and is a new array
        expect(sorted).not.toBe(rows);
    });

    it('sorts bigint columns numerically', () => {
        const bigRows: ParquetRow[] = [
            { id: 'p', n: 100n },
            { id: 'q', n: 9n },
            { id: 'r', n: 11n }
        ];
        const sorted = applySort(bigRows, { columnKey: 'n', direction: 'asc' });
        expect(sorted.map((r) => r.id)).toEqual(['q', 'r', 'p']);
    });

    it('sorts numeric-string columns by parsed value', () => {
        const stringRows: ParquetRow[] = [
            { id: 'p', n: '100' },
            { id: 'q', n: '9' },
            { id: 'r', n: '11' }
        ];
        const sorted = applySort(stringRows, {
            columnKey: 'n',
            direction: 'asc'
        });
        expect(sorted.map((r) => r.id)).toEqual(['q', 'r', 'p']);
    });
});

// --- applySort: text ---------------------------------------------------

describe('applySort — text', () => {
    it('sorts text case-insensitively, lexicographically', () => {
        const rows: ParquetRow[] = [
            { name: 'Charlie' },
            { name: 'alpha' },
            { name: 'bravo' },
            { name: 'ALPHA' }
        ];
        const sorted = applySort(rows, {
            columnKey: 'name',
            direction: 'asc'
        });
        // Case-insensitive: alpha/ALPHA tie, then bravo, then Charlie.
        // Stable: original input order [alpha, ALPHA] preserved within the tie.
        expect(sorted[0].name).toBe('alpha');
        expect(sorted[1].name).toBe('ALPHA');
        expect(sorted[2].name).toBe('bravo');
        expect(sorted[3].name).toBe('Charlie');
    });

    it('sorts mixed (text-typed) descending', () => {
        const rows: ParquetRow[] = [
            { name: 'banana' },
            { name: 'apple' },
            { name: 'cherry' }
        ];
        const sorted = applySort(rows, {
            columnKey: 'name',
            direction: 'desc'
        });
        expect(sorted.map((r) => r.name)).toEqual([
            'cherry',
            'banana',
            'apple'
        ]);
    });

    it('sorts a mixed numeric/text column lexicographically', () => {
        // Auto-detected as text because of "two".
        const rows: ParquetRow[] = [
            { v: 10 },
            { v: 'two' },
            { v: 3 },
            { v: 'apple' }
        ];
        const sorted = applySort(rows, {
            columnKey: 'v',
            direction: 'asc'
        });
        // Text sort with numeric collation enables 3 < 10, then "apple", "two".
        expect(sorted.map((r) => r.v)).toEqual([3, 10, 'apple', 'two']);
    });
});

// --- applySort: stability ---------------------------------------------

describe('applySort — stability (original-index tiebreaker)', () => {
    it('preserves relative order for equal numeric keys', () => {
        const rows: ParquetRow[] = [
            { id: 'a', v: 5 },
            { id: 'b', v: 5 },
            { id: 'c', v: 1 },
            { id: 'd', v: 5 }
        ];
        const sorted = applySort(rows, {
            columnKey: 'v',
            direction: 'asc'
        });
        // 1 first, then the three 5s in original order: a, b, d.
        expect(sorted.map((r) => r.id)).toEqual(['c', 'a', 'b', 'd']);
    });

    it('preserves relative order for all-equal asc', () => {
        const rows: ParquetRow[] = [
            { id: 'a', v: 'x' },
            { id: 'b', v: 'x' },
            { id: 'c', v: 'x' }
        ];
        const sorted = applySort(rows, {
            columnKey: 'v',
            direction: 'asc'
        });
        expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('preserves relative order for all-equal desc', () => {
        const rows: ParquetRow[] = [
            { id: 'a', v: 'x' },
            { id: 'b', v: 'x' },
            { id: 'c', v: 'x' }
        ];
        const sorted = applySort(rows, {
            columnKey: 'v',
            direction: 'desc'
        });
        expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });
});

// --- applySort: empty cells -------------------------------------------

describe('applySort — null / undefined cells', () => {
    it('sends nulls to the end (asc, numeric)', () => {
        const rows: ParquetRow[] = [
            { id: 'a', v: 10 },
            { id: 'b', v: null },
            { id: 'c', v: 2 },
            { id: 'd', v: undefined },
            { id: 'e', v: 7 }
        ];
        const sorted = applySort(rows, {
            columnKey: 'v',
            direction: 'asc'
        });
        // 2, 7, 10, then nulls in original order: b, d.
        expect(sorted.map((r) => r.id)).toEqual(['c', 'e', 'a', 'b', 'd']);
    });

    it('sends nulls to the end (desc, numeric)', () => {
        const rows: ParquetRow[] = [
            { id: 'a', v: 10 },
            { id: 'b', v: null },
            { id: 'c', v: 2 },
            { id: 'd', v: undefined },
            { id: 'e', v: 7 }
        ];
        const sorted = applySort(rows, {
            columnKey: 'v',
            direction: 'desc'
        });
        // 10, 7, 2, then nulls in original order: b, d.
        expect(sorted.map((r) => r.id)).toEqual(['a', 'e', 'c', 'b', 'd']);
    });

    it('sends nulls to the end (text column)', () => {
        const rows: ParquetRow[] = [
            { v: 'beta' },
            { v: null },
            { v: 'alpha' }
        ];
        const sorted = applySort(rows, {
            columnKey: 'v',
            direction: 'asc'
        });
        expect(sorted.map((r) => r.v)).toEqual(['alpha', 'beta', null]);
    });
});

// --- applySort: input not mutated -------------------------------------

describe('applySort — does not mutate input', () => {
    it('returns a fresh array', () => {
        const rows: ParquetRow[] = [{ v: 1 }, { v: 2 }, { v: 3 }];
        const snapshot = rows.map((r) => ({ ...r }));
        applySort(rows, { columnKey: 'v', direction: 'desc' });
        expect(rows).toEqual(snapshot);
    });
});

// --- cellToSearchText / rowMatchesSearch / filterRows -----------------

describe('cellToSearchText', () => {
    it('renders null and undefined as their literal labels', () => {
        expect(cellToSearchText(null)).toBe('null');
        expect(cellToSearchText(undefined)).toBe('undefined');
    });

    it('renders bigint as the decimal digits', () => {
        expect(cellToSearchText(12345n)).toBe('12345');
    });

    it('renders numbers as String(value)', () => {
        expect(cellToSearchText(42)).toBe('42');
        expect(cellToSearchText(1.5)).toBe('1.5');
    });

    it('renders booleans as the literal strings', () => {
        expect(cellToSearchText(true)).toBe('true');
        expect(cellToSearchText(false)).toBe('false');
    });

    it('renders structured values via JSON.stringify', () => {
        expect(cellToSearchText({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
        expect(cellToSearchText([1, 2, 3])).toBe('[1,2,3]');
    });

    it('renders a Uint8Array as a hex preview', () => {
        const bytes = new Uint8Array([0x00, 0xff, 0x10]);
        expect(cellToSearchText(bytes)).toBe('00 ff 10');
    });

    it('renders bigint inside an object via the JSON BigInt replacer', () => {
        expect(cellToSearchText({ id: 99n })).toBe('{"id":"99"}');
    });
});

describe('rowMatchesSearch', () => {
    const row: ParquetRow = {
        name: 'Alice',
        city: 'San Francisco',
        age: 30,
        notes: null
    };

    it('returns true when search is empty', () => {
        expect(rowMatchesSearch(row, '')).toBe(true);
    });

    it('returns false when row is null/undefined and search is non-empty', () => {
        expect(rowMatchesSearch(null, 'x')).toBe(false);
        expect(rowMatchesSearch(undefined, 'x')).toBe(false);
    });

    it('matches case-insensitively across columns', () => {
        expect(rowMatchesSearch(row, 'sa')).toBe(true);
        expect(rowMatchesSearch(row, 'SAN')).toBe(true);
        expect(rowMatchesSearch(row, 'alice')).toBe(true);
    });

    it('matches numbers when stringified', () => {
        expect(rowMatchesSearch(row, '30')).toBe(true);
    });

    it('matches the literal "null" against a null cell', () => {
        // Per cellToSearchText null -> "null", so a "null" search hits.
        expect(rowMatchesSearch(row, 'null')).toBe(true);
    });

    it('returns false when no column contains the term', () => {
        expect(rowMatchesSearch(row, 'zzz')).toBe(false);
    });
});

describe('filterRows', () => {
    const rows: ParquetRow[] = [
        { name: 'Alice', city: 'NYC' },
        { name: 'Bob', city: 'San Francisco' },
        { name: 'Carol', city: 'LA' },
        { name: 'Dan', city: 'San Diego' }
    ];

    it('returns all rows (fresh copy) when search is empty', () => {
        const filtered = filterRows(rows, '');
        expect(filtered).toEqual(rows);
        expect(filtered).not.toBe(rows);
    });

    it('filters by case-insensitive contains across columns', () => {
        const filtered = filterRows(rows, 'san');
        expect(filtered.map((r) => r.name)).toEqual(['Bob', 'Dan']);
    });

    it('returns an empty array when nothing matches', () => {
        expect(filterRows(rows, 'zzz')).toEqual([]);
    });
});

// --- pagination helpers -----------------------------------------------

describe('totalPageCount + clampPage', () => {
    it('returns 1 for empty data', () => {
        expect(
            totalPageCount({ page: 1, rowsPerPage: 200, totalRows: 0 })
        ).toBe(1);
    });

    it('rounds up to whole pages', () => {
        expect(
            totalPageCount({ page: 1, rowsPerPage: 200, totalRows: 201 })
        ).toBe(2);
        expect(
            totalPageCount({ page: 1, rowsPerPage: 200, totalRows: 400 })
        ).toBe(2);
        expect(
            totalPageCount({ page: 1, rowsPerPage: 200, totalRows: 401 })
        ).toBe(3);
    });

    it('clampPage floors at 1 and ceils at totalPages', () => {
        expect(clampPage({ page: 0, rowsPerPage: 100, totalRows: 1000 })).toBe(
            1
        );
        expect(
            clampPage({ page: 999, rowsPerPage: 100, totalRows: 1000 })
        ).toBe(10);
    });
});

describe('getPageSlice', () => {
    const rows: ParquetRow[] = Array.from({ length: 250 }, (_, i) => ({
        id: i
    }));

    it('first page', () => {
        const slice = getPageSlice(rows, {
            page: 1,
            rowsPerPage: 100,
            totalRows: 250
        });
        expect(slice.startIndex).toBe(0);
        expect(slice.endIndex).toBe(100);
        expect(slice.rows).toHaveLength(100);
    });

    it('last (partial) page', () => {
        const slice = getPageSlice(rows, {
            page: 3,
            rowsPerPage: 100,
            totalRows: 250
        });
        expect(slice.startIndex).toBe(200);
        expect(slice.endIndex).toBe(250);
        expect(slice.rows).toHaveLength(50);
    });

    it('clamps an out-of-range page back to last', () => {
        const slice = getPageSlice(rows, {
            page: 99,
            rowsPerPage: 100,
            totalRows: 250
        });
        expect(slice.startIndex).toBe(200);
        expect(slice.endIndex).toBe(250);
    });

    it('empty rows -> empty slice', () => {
        const slice = getPageSlice([], {
            page: 1,
            rowsPerPage: 100,
            totalRows: 0
        });
        expect(slice.rows).toHaveLength(0);
    });
});

describe('nextPage / prevPage', () => {
    it('nextPage clamps at totalPages', () => {
        const s = nextPage({ page: 5, rowsPerPage: 100, totalRows: 500 });
        expect(s.page).toBe(5); // already last
    });

    it('prevPage clamps at 1', () => {
        const s = prevPage({ page: 1, rowsPerPage: 100, totalRows: 500 });
        expect(s.page).toBe(1);
    });

    it('nextPage advances by 1', () => {
        const s = nextPage({ page: 1, rowsPerPage: 100, totalRows: 500 });
        expect(s.page).toBe(2);
    });

    it('prevPage retreats by 1', () => {
        const s = prevPage({ page: 3, rowsPerPage: 100, totalRows: 500 });
        expect(s.page).toBe(2);
    });
});

describe('applySearch — search reset to page 1', () => {
    const rows: ParquetRow[] = Array.from({ length: 500 }, (_, i) => ({
        id: i,
        name: `name-${i}`
    }));

    it('resets pagination to page 1 (DoD)', () => {
        const res = applySearch(rows, '50', 200);
        expect(res.pagination.page).toBe(1);
        expect(res.pagination.rowsPerPage).toBe(200);
    });

    it('sets pagination.totalRows to the filtered count', () => {
        const res = applySearch(rows, 'name-5', 200);
        expect(res.pagination.totalRows).toBe(res.filtered.length);
        expect(res.filtered.length).toBeGreaterThan(0);
    });

    it('uses DEFAULT_ROWS_PER_PAGE when not provided', () => {
        const res = applySearch(rows, '');
        expect(res.pagination.rowsPerPage).toBe(DEFAULT_ROWS_PER_PAGE);
    });
});

describe('DEFAULT_ROWS_PER_PAGE', () => {
    it('matches the issue #40 default of 200', () => {
        expect(DEFAULT_ROWS_PER_PAGE).toBe(200);
    });
});

// --- responsiveness sanity check (10k rows) ---------------------------

describe('helpers handle 10k rows quickly', () => {
    const rows: ParquetRow[] = Array.from({ length: 10_000 }, (_, i) => ({
        id: i,
        name: `row-${i}`,
        value: (i * 31) % 9973
    }));

    it('filters, sorts, and pages 10k rows under 1s', () => {
        const t0 = Date.now();
        const filtered = filterRows(rows, '7');
        const sorted = applySort(filtered, {
            columnKey: 'value',
            direction: 'desc'
        });
        const slice = getPageSlice(sorted, {
            page: 1,
            rowsPerPage: 200,
            totalRows: sorted.length
        });
        const dt = Date.now() - t0;
        // Generous bound — even on a slow CI worker this should complete
        // in well under a second. The bound exists to flag a future
        // accidental quadratic blow-up, not to pin exact latency.
        expect(dt).toBeLessThan(1000);
        expect(slice.rows.length).toBeGreaterThan(0);
        expect(slice.rows.length).toBeLessThanOrEqual(200);
    });
});
