import {
    DEFAULT_ROWS_PER_PAGE,
    applySearch,
    clampPage,
    filterRows,
    getPageSlice,
    nextPage,
    prevPage,
    rowMatchesSearch,
    stringifyCell,
    totalPageCount
} from '../templates/excel/js/excelPagination';

describe('totalPageCount + clampPage', () => {
    it('returns 1 for empty data', () => {
        expect(totalPageCount({ page: 1, rowsPerPage: 200, totalRows: 0 })).toBe(1);
    });
    it('rounds up to whole pages', () => {
        expect(totalPageCount({ page: 1, rowsPerPage: 200, totalRows: 201 })).toBe(2);
        expect(totalPageCount({ page: 1, rowsPerPage: 200, totalRows: 400 })).toBe(2);
        expect(totalPageCount({ page: 1, rowsPerPage: 200, totalRows: 401 })).toBe(3);
    });
    it('clampPage floors at 1 and ceils at totalPages', () => {
        expect(clampPage({ page: 0, rowsPerPage: 100, totalRows: 1000 })).toBe(1);
        expect(clampPage({ page: 999, rowsPerPage: 100, totalRows: 1000 })).toBe(10);
    });
});

describe('getPageSlice', () => {
    const rows = Array.from({ length: 250 }, (_, i) => [i, `r${i}`]);
    it('first page', () => {
        const slice = getPageSlice(rows, { page: 1, rowsPerPage: 100, totalRows: 250 });
        expect(slice.startIndex).toBe(0);
        expect(slice.endIndex).toBe(100);
        expect(slice.rows).toHaveLength(100);
    });
    it('last (partial) page', () => {
        const slice = getPageSlice(rows, { page: 3, rowsPerPage: 100, totalRows: 250 });
        expect(slice.startIndex).toBe(200);
        expect(slice.endIndex).toBe(250);
        expect(slice.rows).toHaveLength(50);
    });
    it('clamps an out-of-range page back to last', () => {
        const slice = getPageSlice(rows, { page: 99, rowsPerPage: 100, totalRows: 250 });
        expect(slice.startIndex).toBe(200);
        expect(slice.endIndex).toBe(250);
    });
    it('empty rows -> empty slice', () => {
        const slice = getPageSlice([], { page: 1, rowsPerPage: 100, totalRows: 0 });
        expect(slice.rows).toHaveLength(0);
    });
});

describe('rowMatchesSearch + filterRows', () => {
    const rows = [
        ['Alice', 30, 'NYC'],
        ['Bob', 25, 'San Francisco'],
        ['Carol', null, 'LA'],
        [{ tag: 'special' }, 99, 'Paris']
    ];
    it('returns all rows when search is empty', () => {
        expect(filterRows(rows, '')).toEqual(rows);
    });
    it('case-insensitive contains across columns', () => {
        expect(filterRows(rows, 'sa')).toHaveLength(1); // san francisco
        expect(filterRows(rows, 'SA')).toHaveLength(1);
    });
    it('matches a number cell when stringified', () => {
        expect(filterRows(rows, '99')).toHaveLength(1);
    });
    it('matches an object cell via JSON.stringify', () => {
        expect(filterRows(rows, 'special')).toHaveLength(1);
    });
    it('rowMatchesSearch on undefined row returns false (with non-empty term)', () => {
        expect(rowMatchesSearch(undefined, 'x')).toBe(false);
    });
    it('rowMatchesSearch on empty row returns false (with non-empty term)', () => {
        expect(rowMatchesSearch([], 'x')).toBe(false);
    });
});

describe('stringifyCell', () => {
    it('null/undefined -> empty string', () => {
        expect(stringifyCell(null)).toBe('');
        expect(stringifyCell(undefined)).toBe('');
    });
    it('numbers/booleans -> string', () => {
        expect(stringifyCell(42)).toBe('42');
        expect(stringifyCell(true)).toBe('true');
    });
    it('object -> JSON', () => {
        expect(stringifyCell({ a: 1 })).toBe('{"a":1}');
    });
});

describe('applySearch', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [i, `name-${i}`]);
    it('resets pagination to page 1', () => {
        const res = applySearch(rows, '50', 200);
        expect(res.pagination.page).toBe(1);
        expect(res.pagination.rowsPerPage).toBe(200);
    });
    it('sets pagination.totalRows to filtered length', () => {
        const res = applySearch(rows, '5', 200);
        // any row whose stringified content contains "5"
        expect(res.pagination.totalRows).toBe(res.filtered.length);
        expect(res.filtered.length).toBeGreaterThan(0);
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
});

describe('DEFAULT_ROWS_PER_PAGE', () => {
    it('matches issue #36 default of 200', () => {
        expect(DEFAULT_ROWS_PER_PAGE).toBe(200);
    });
});
