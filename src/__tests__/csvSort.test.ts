// Unit tests for the CSV column-sort helpers (issue #33).
//
// Coverage:
//   - 3-state cycle: asc -> desc -> none, switching columns resets to asc.
//   - Type detection: numeric / date / text, mixed -> text.
//   - Stable sort: equal keys preserve their original relative order.
//   - Numeric sort: "10" > "9" (i.e. compares as number, not string).
//   - Date sort: chronological, not lexicographic.
//   - Text sort: locale-aware, case-insensitive.
//   - Empty values always sort to the end (asc and desc).

import {
    applySort,
    detectColumnType,
    nextSortState,
    SortState
} from '../templates/csv/js/csvSort';

describe('nextSortState', () => {
    const NONE: SortState = { columnIndex: null, direction: null };

    it('starts at asc when no column is sorted', () => {
        expect(nextSortState(NONE, 0)).toEqual({
            columnIndex: 0,
            direction: 'asc'
        });
    });

    it('cycles asc -> desc on the same column', () => {
        const after = nextSortState(
            { columnIndex: 2, direction: 'asc' },
            2
        );
        expect(after).toEqual({ columnIndex: 2, direction: 'desc' });
    });

    it('cycles desc -> none on the same column', () => {
        const after = nextSortState(
            { columnIndex: 2, direction: 'desc' },
            2
        );
        expect(after).toEqual({ columnIndex: null, direction: null });
    });

    it('cycles none -> asc on the same column', () => {
        const after = nextSortState(NONE, 5);
        expect(after).toEqual({ columnIndex: 5, direction: 'asc' });
    });

    it('clicking a different column resets to asc on that column', () => {
        const after = nextSortState(
            { columnIndex: 1, direction: 'desc' },
            3
        );
        expect(after).toEqual({ columnIndex: 3, direction: 'asc' });
    });

    it('completes a full asc->desc->none cycle', () => {
        let state: SortState = NONE;
        state = nextSortState(state, 0);
        expect(state.direction).toBe('asc');
        state = nextSortState(state, 0);
        expect(state.direction).toBe('desc');
        state = nextSortState(state, 0);
        expect(state).toEqual(NONE);
    });
});

describe('detectColumnType', () => {
    it('detects integer columns as number', () => {
        expect(detectColumnType(['1', '42', '7'])).toBe('number');
    });

    it('detects mixed integer/float columns as number', () => {
        expect(detectColumnType(['1', '2.5', '-3', '4e2'])).toBe('number');
    });

    it('treats empty strings as not type-defining', () => {
        expect(detectColumnType(['', '1', '', '2'])).toBe('number');
        expect(detectColumnType(['', '', ''])).toBe('text');
    });

    it('detects ISO dates as date', () => {
        expect(
            detectColumnType(['2024-01-01', '2024-02-15', '2023-12-31'])
        ).toBe('date');
    });

    it('does NOT classify pure numeric strings as date', () => {
        // "1234" parses to a Date but lacks date-shape characters.
        expect(detectColumnType(['1234', '5678'])).toBe('number');
    });

    it('falls back to text for mixed numeric + alpha', () => {
        expect(detectColumnType(['1', 'two', '3'])).toBe('text');
    });

    it('returns text for an all-empty column', () => {
        expect(detectColumnType([])).toBe('text');
    });
});

// Helpers --------------------------------------------------------------------

function makeRows(rows: string[][]): string[][] {
    return rows;
}

function getCell(rows: string[][]) {
    return (rowIndex: number, colIndex: number) =>
        rows[rowIndex]?.[colIndex] ?? '';
}

function indices(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
}

describe('applySort — numeric', () => {
    const rows = makeRows([
        ['a', '10'],
        ['b', '2'],
        ['c', '11'],
        ['d', '1']
    ]);

    it('sorts numerically ascending (not lexicographically)', () => {
        const sorted = applySort(
            indices(rows.length),
            { columnIndex: 1, direction: 'asc' },
            getCell(rows)
        );
        // Expected order by numeric value: 1, 2, 10, 11 -> rows d,b,a,c
        expect(sorted).toEqual([3, 1, 0, 2]);
    });

    it('sorts numerically descending', () => {
        const sorted = applySort(
            indices(rows.length),
            { columnIndex: 1, direction: 'desc' },
            getCell(rows)
        );
        // 11, 10, 2, 1 -> c,a,b,d
        expect(sorted).toEqual([2, 0, 1, 3]);
    });

    it('returns a copy unchanged when state is none', () => {
        const sorted = applySort(
            indices(rows.length),
            { columnIndex: null, direction: null },
            getCell(rows)
        );
        expect(sorted).toEqual([0, 1, 2, 3]);
    });
});

describe('applySort — text', () => {
    const rows = makeRows([
        ['Charlie'],
        ['alpha'],
        ['bravo'],
        ['ALPHA']
    ]);

    it('sorts text case-insensitively', () => {
        const sorted = applySort(
            indices(rows.length),
            { columnIndex: 0, direction: 'asc' },
            getCell(rows)
        );
        // Expected (case-insensitive): alpha/ALPHA tie, bravo, Charlie.
        // Stable: original order [1=alpha, 3=ALPHA] preserved within the tie.
        expect(sorted.slice(0, 2).sort()).toEqual([1, 3]);
        expect(sorted[2]).toBe(2);
        expect(sorted[3]).toBe(0);
    });
});

describe('applySort — date', () => {
    const rows = makeRows([
        ['2024-03-15'],
        ['2023-01-01'],
        ['2024-01-02'],
        ['2024-03-15'] // duplicate
    ]);

    it('sorts dates chronologically, not lexicographically', () => {
        const sorted = applySort(
            indices(rows.length),
            { columnIndex: 0, direction: 'asc' },
            getCell(rows)
        );
        // 2023-01-01, 2024-01-02, 2024-03-15, 2024-03-15
        expect(sorted).toEqual([1, 2, 0, 3]);
    });

    it('descending reverses chronology but keeps duplicate-pair stable', () => {
        const sorted = applySort(
            indices(rows.length),
            { columnIndex: 0, direction: 'desc' },
            getCell(rows)
        );
        // 2024-03-15, 2024-03-15, 2024-01-02, 2023-01-01
        // Stable means the two 2024-03-15 keep original order [0, 3].
        expect(sorted).toEqual([0, 3, 2, 1]);
    });
});

describe('applySort — stability', () => {
    it('preserves relative order for equal keys (asc)', () => {
        // All values equal -> output should equal input order.
        const rows = makeRows([['x'], ['x'], ['x'], ['x']]);
        const sorted = applySort(
            indices(rows.length),
            { columnIndex: 0, direction: 'asc' },
            getCell(rows)
        );
        expect(sorted).toEqual([0, 1, 2, 3]);
    });

    it('preserves relative order for equal keys (desc)', () => {
        const rows = makeRows([['x'], ['x'], ['x'], ['x']]);
        const sorted = applySort(
            indices(rows.length),
            { columnIndex: 0, direction: 'desc' },
            getCell(rows)
        );
        expect(sorted).toEqual([0, 1, 2, 3]);
    });

    it('preserves relative order within numeric duplicates', () => {
        const rows = makeRows([
            ['a', '5'],
            ['b', '5'],
            ['c', '1'],
            ['d', '5']
        ]);
        const sorted = applySort(
            indices(rows.length),
            { columnIndex: 1, direction: 'asc' },
            getCell(rows)
        );
        // 1 comes first, then the three 5s in original order: a,b,d
        expect(sorted).toEqual([2, 0, 1, 3]);
    });
});

describe('applySort — empty values', () => {
    const rows = makeRows([
        ['10'],
        [''],
        ['2'],
        ['  '], // whitespace-only -> empty
        ['7']
    ]);

    it('sends empty cells to the end (asc)', () => {
        const sorted = applySort(
            indices(rows.length),
            { columnIndex: 0, direction: 'asc' },
            getCell(rows)
        );
        // Non-empty asc: 2, 7, 10 -> rows 2,4,0; empties at end stable: 1,3
        expect(sorted).toEqual([2, 4, 0, 1, 3]);
    });

    it('sends empty cells to the end (desc) too', () => {
        const sorted = applySort(
            indices(rows.length),
            { columnIndex: 0, direction: 'desc' },
            getCell(rows)
        );
        // Non-empty desc: 10, 7, 2 -> rows 0,4,2; empties at end stable: 1,3
        expect(sorted).toEqual([0, 4, 2, 1, 3]);
    });
});

describe('applySort — does not mutate input', () => {
    it('returns a fresh array', () => {
        const rows = makeRows([['1'], ['2'], ['3']]);
        const input = indices(rows.length);
        const inputCopy = [...input];
        applySort(
            input,
            { columnIndex: 0, direction: 'desc' },
            getCell(rows)
        );
        expect(input).toEqual(inputCopy);
    });
});
