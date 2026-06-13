// Unit tests for the CSV statistics helpers (issue #35).
//
// Coverage:
//   - isNullCell / parseNumericCell edge cases (undefined, whitespace, NaN).
//   - isNumericColumn: needs ≥1 non-empty value, mixed cells -> not numeric,
//     all-empty -> not numeric.
//   - computeStatistics: row/column totals, null %, mean/min/max for numeric,
//     numeric === null when any non-empty cell is non-numeric.
//   - escapeTsvCell quoting rules (tab, newline, embedded quote, plain text).
//   - serializeRowsToTsv with and without headers + empty input.
//   - formatStatNumber / formatPercent rounding.

import {
    ColumnStats,
    computeStatistics,
    escapeTsvCell,
    formatPercent,
    formatStatNumber,
    isNullCell,
    isNumericColumn,
    parseNumericCell,
    serializeRowsToTsv
} from '../templates/csv/js/csvStatistics';

describe('isNullCell', () => {
    it('returns true for undefined / null', () => {
        expect(isNullCell(undefined)).toBe(true);
        expect(isNullCell(null)).toBe(true);
    });

    it('returns true for empty / whitespace-only strings', () => {
        expect(isNullCell('')).toBe(true);
        expect(isNullCell('   ')).toBe(true);
        expect(isNullCell('\t\n')).toBe(true);
    });

    it('returns false for any cell with a non-whitespace character', () => {
        expect(isNullCell('0')).toBe(false);
        expect(isNullCell(' x ')).toBe(false);
        expect(isNullCell('false')).toBe(false);
    });
});

describe('parseNumericCell', () => {
    it('parses integers and decimals', () => {
        expect(parseNumericCell('42')).toBe(42);
        expect(parseNumericCell('  -3.5 ')).toBe(-3.5);
        expect(parseNumericCell('0')).toBe(0);
    });

    it('parses scientific notation', () => {
        expect(parseNumericCell('1e3')).toBe(1000);
    });

    it('returns null for non-numeric, NaN, or empty cells', () => {
        expect(parseNumericCell('abc')).toBeNull();
        expect(parseNumericCell('NaN')).toBeNull();
        expect(parseNumericCell('')).toBeNull();
        expect(parseNumericCell('  ')).toBeNull();
        expect(parseNumericCell(undefined)).toBeNull();
        expect(parseNumericCell('1.2.3')).toBeNull();
    });
});

describe('isNumericColumn', () => {
    it('returns true when every non-empty cell parses', () => {
        expect(isNumericColumn(['1', '2', '3.5'])).toBe(true);
    });

    it('ignores empty cells when classifying', () => {
        expect(isNumericColumn(['1', '', '   ', '2'])).toBe(true);
    });

    it('returns false when any non-empty cell is non-numeric', () => {
        expect(isNumericColumn(['1', 'two', '3'])).toBe(false);
    });

    it('returns false for all-empty columns', () => {
        expect(isNumericColumn(['', '   ', undefined, null])).toBe(false);
    });

    it('returns false for an empty values list', () => {
        expect(isNumericColumn([])).toBe(false);
    });
});

describe('computeStatistics', () => {
    it('returns one entry per header even for empty input', () => {
        const stats = computeStatistics([], ['a', 'b']);
        expect(stats).toHaveLength(2);
        expect(stats[0]).toEqual<ColumnStats>({
            header: 'a',
            columnIndex: 0,
            total: 0,
            count: 0,
            nullCount: 0,
            nullPercent: 0,
            numeric: null
        });
    });

    it('counts nulls and computes null percentage', () => {
        const rows: string[][] = [
            ['1', ''],
            ['2', '   '],
            ['', 'x'],
            ['3', 'y']
        ];
        const stats = computeStatistics(rows, ['n', 's']);

        expect(stats[0].total).toBe(4);
        expect(stats[0].count).toBe(3);
        expect(stats[0].nullCount).toBe(1);
        expect(stats[0].nullPercent).toBeCloseTo(0.25);

        expect(stats[1].nullCount).toBe(2);
        expect(stats[1].nullPercent).toBeCloseTo(0.5);
    });

    it('computes mean / min / max over the numeric (non-empty) values only', () => {
        const rows: string[][] = [
            ['10'],
            [''],
            ['2'],
            ['8']
        ];
        const stats = computeStatistics(rows, ['n']);
        const numeric = stats[0].numeric!;
        expect(numeric).not.toBeNull();
        expect(numeric.count).toBe(3);
        expect(numeric.min).toBe(2);
        expect(numeric.max).toBe(10);
        expect(numeric.mean).toBeCloseTo((10 + 2 + 8) / 3);
    });

    it('reports numeric === null when any non-empty cell is non-numeric', () => {
        const rows: string[][] = [['1'], ['two'], ['3']];
        const stats = computeStatistics(rows, ['mixed']);
        expect(stats[0].numeric).toBeNull();
        expect(stats[0].count).toBe(3);
    });

    it('reports numeric === null for an all-null column even though count is 0', () => {
        const rows: string[][] = [[''], ['  '], ['']];
        const stats = computeStatistics(rows, ['empty']);
        expect(stats[0].count).toBe(0);
        expect(stats[0].nullCount).toBe(3);
        expect(stats[0].nullPercent).toBe(1);
        expect(stats[0].numeric).toBeNull();
    });

    it('handles negative numbers and decimals correctly', () => {
        const rows: string[][] = [['-5'], ['0'], ['2.5'], ['-1.5']];
        const stats = computeStatistics(rows, ['v']);
        const numeric = stats[0].numeric!;
        expect(numeric.min).toBe(-5);
        expect(numeric.max).toBe(2.5);
        expect(numeric.mean).toBeCloseTo((-5 + 0 + 2.5 - 1.5) / 4);
    });

    it('tolerates short rows (missing trailing cells treated as null)', () => {
        const rows: string[][] = [['1', '2'], ['3'], ['4', '5']];
        const stats = computeStatistics(rows, ['a', 'b']);
        expect(stats[1].nullCount).toBe(1);
        expect(stats[1].count).toBe(2);
        expect(stats[1].numeric?.mean).toBeCloseTo(3.5);
    });

    it('returns headers and column indices in order', () => {
        const stats = computeStatistics([['1', '2', '3']], ['a', 'b', 'c']);
        expect(stats.map((s) => s.header)).toEqual(['a', 'b', 'c']);
        expect(stats.map((s) => s.columnIndex)).toEqual([0, 1, 2]);
    });
});

describe('escapeTsvCell', () => {
    it('passes through plain text unchanged', () => {
        expect(escapeTsvCell('hello')).toBe('hello');
        expect(escapeTsvCell('123.45')).toBe('123.45');
    });

    it('quotes cells containing tabs, CR, or LF', () => {
        expect(escapeTsvCell('a\tb')).toBe('"a\tb"');
        expect(escapeTsvCell('a\nb')).toBe('"a\nb"');
        expect(escapeTsvCell('a\r\nb')).toBe('"a\r\nb"');
    });

    it('quotes and doubles embedded double quotes', () => {
        expect(escapeTsvCell('say "hi"')).toBe('"say ""hi"""');
    });

    it('returns empty string for null / undefined', () => {
        expect(escapeTsvCell(undefined)).toBe('');
        expect(escapeTsvCell(null)).toBe('');
        expect(escapeTsvCell('')).toBe('');
    });
});

describe('serializeRowsToTsv', () => {
    it('joins rows with tabs and newlines', () => {
        const out = serializeRowsToTsv([['a', 'b'], ['c', 'd']]);
        expect(out).toBe('a\tb\nc\td');
    });

    it('emits headers as the first line when provided', () => {
        const out = serializeRowsToTsv([['1', '2']], ['x', 'y']);
        expect(out).toBe('x\ty\n1\t2');
    });

    it('escapes cells that contain tabs / quotes', () => {
        const out = serializeRowsToTsv([['a\tb', 'c"d']]);
        expect(out).toBe('"a\tb"\t"c""d"');
    });

    it('handles empty rows array', () => {
        expect(serializeRowsToTsv([])).toBe('');
        expect(serializeRowsToTsv([], ['a', 'b'])).toBe('a\tb');
    });

    it('renders null/undefined cells as empty fields', () => {
        const out = serializeRowsToTsv([[undefined, 'x', null]]);
        expect(out).toBe('\tx\t');
    });
});

describe('formatStatNumber', () => {
    it('formats integers without decimals', () => {
        expect(formatStatNumber(42)).toBe('42');
        expect(formatStatNumber(0)).toBe('0');
        expect(formatStatNumber(-7)).toBe('-7');
    });

    it('strips trailing zeros from decimals', () => {
        expect(formatStatNumber(1.5)).toBe('1.5');
        expect(formatStatNumber(1.2500)).toBe('1.25');
    });

    it('truncates to 4 fractional digits', () => {
        expect(formatStatNumber(1 / 3)).toBe('0.3333');
    });

    it('returns em-dash for non-finite numbers', () => {
        expect(formatStatNumber(NaN)).toBe('—');
        expect(formatStatNumber(Infinity)).toBe('—');
    });
});

describe('formatPercent', () => {
    it('formats integer percentages cleanly', () => {
        expect(formatPercent(0)).toBe('0%');
        expect(formatPercent(0.5)).toBe('50%');
        expect(formatPercent(1)).toBe('100%');
    });

    it('formats fractional percentages with one decimal', () => {
        expect(formatPercent(0.123)).toBe('12.3%');
    });

    it('strips trailing .0', () => {
        expect(formatPercent(0.1)).toBe('10%');
    });

    it('returns em-dash for non-finite input', () => {
        expect(formatPercent(NaN)).toBe('—');
    });
});
