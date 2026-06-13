// Unit tests for the Excel viewer's Copy / Copy-as-JSON serializers
// (issue #37).
//
// Coverage targets:
//   - TSV escape strategy: cells containing tabs, newlines, or double
//     quotes get RFC-4180 quoting (double-quote wrap + `""` doubling),
//     plain cells stay unquoted.
//   - JSON shape: `serializeRowsAsJson` returns a plain
//     `Array<Record<string, value>>` whose keys mirror the headers and
//     whose values preserve primitive type (number / boolean / null).
//   - Header / row mismatch tolerance: ragged rows don't lose data and
//     don't desynchronize the column alignment.
//   - Reuse of `stringifyCell` so the clipboard output matches what the
//     user sees on screen (object cells -> JSON, null -> empty in TSV).

import { Row } from '../templates/excel/js/excelPagination';
import {
    serializeRowsAsJson,
    serializeRowsAsTsv
} from '../templates/excel/js/excelExport';

describe('serializeRowsAsTsv', () => {
    it('emits a header line followed by tab-joined data rows', () => {
        const tsv = serializeRowsAsTsv(
            ['name', 'age', 'city'],
            [
                ['Alice', 30, 'NYC'],
                ['Bob', 25, 'SF']
            ]
        );
        expect(tsv).toBe('name\tage\tcity\nAlice\t30\tNYC\nBob\t25\tSF');
    });

    it('quotes cells that contain a TAB and leaves plain cells alone', () => {
        const tsv = serializeRowsAsTsv(['a', 'b'], [['plain', 'has\tinside']]);
        const lines = tsv.split('\n');
        expect(lines[0]).toBe('a\tb');
        // RFC-4180-style: the cell is wrapped in `"…"` so a TSV parser that
        // honours quotes will treat the embedded TAB as part of the cell.
        expect(lines[1]).toBe('plain\t"has\tinside"');
    });

    it('quotes cells that contain a newline (\\n or \\r)', () => {
        const tsv = serializeRowsAsTsv(['a'], [['line1\nline2'], ['cr\rhere']]);
        const lines = tsv.split('\n');
        expect(lines[0]).toBe('a');
        expect(lines[1]).toBe('"line1');
        expect(lines[2]).toBe('line2"');
        expect(lines[3]).toBe('"cr\rhere"');
    });

    it('doubles embedded double-quotes inside quoted cells', () => {
        const tsv = serializeRowsAsTsv(['a'], [['say "hi"']]);
        // Triggered by the `"` itself: wrap in quotes, double the inner ones.
        expect(tsv).toBe('a\n"say ""hi"""');
    });

    it('does not quote cells that contain only a single quote (apostrophe)', () => {
        const tsv = serializeRowsAsTsv(['a'], [["it's fine"]]);
        expect(tsv).toBe("a\nit's fine");
    });

    it('renders null/undefined as empty cells (matching stringifyCell)', () => {
        const tsv = serializeRowsAsTsv(
            ['a', 'b', 'c'],
            [[null, undefined, 'x']]
        );
        expect(tsv).toBe('a\tb\tc\n\t\tx');
    });

    it('json-stringifies object cells and then quotes the result', () => {
        const tsv = serializeRowsAsTsv(['payload'], [[{ tag: 'special' } as unknown as Row[number]]]);
        // stringifyCell -> {"tag":"special"} which contains `"` so gets wrapped.
        expect(tsv).toBe('payload\n"{""tag"":""special""}"');
    });

    it('handles boolean and number cells without quoting', () => {
        const tsv = serializeRowsAsTsv(['flag', 'count'], [[true, 0], [false, 42]]);
        expect(tsv).toBe('flag\tcount\ntrue\t0\nfalse\t42');
    });

    it('pads short rows with empty cells up to the header column count', () => {
        const tsv = serializeRowsAsTsv(['a', 'b', 'c'], [['x']]);
        // row is shorter than headers — trailing cells become empty strings.
        expect(tsv).toBe('a\tb\tc\nx\t\t');
    });

    it('keeps extra cells when a row is wider than the header', () => {
        const tsv = serializeRowsAsTsv(['a'], [['x', 'y', 'z']]);
        // row is wider than headers — no data is dropped.
        expect(tsv).toBe('a\nx\ty\tz');
    });

    it('emits just the header when rows is empty', () => {
        expect(serializeRowsAsTsv(['a', 'b'], [])).toBe('a\tb');
    });

    it('quotes header cells that themselves contain TSV-special chars', () => {
        const tsv = serializeRowsAsTsv(['col\twith\ttab', 'plain'], [['x', 'y']]);
        expect(tsv.split('\n')[0]).toBe('"col\twith\ttab"\tplain');
    });
});

describe('serializeRowsAsJson', () => {
    it('returns an array of plain objects keyed by header', () => {
        const json = serializeRowsAsJson(
            ['name', 'age'],
            [
                ['Alice', 30],
                ['Bob', 25]
            ]
        );
        expect(json).toEqual([
            { name: 'Alice', age: 30 },
            { name: 'Bob', age: 25 }
        ]);
        // Each entry is a plain object literal — no prototype surprises.
        json.forEach((entry) => {
            expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
        });
    });

    it('preserves primitive types (number / boolean / null)', () => {
        const json = serializeRowsAsJson(
            ['n', 'b', 'x'],
            [[42, true, null]]
        );
        expect(json[0].n).toBe(42);
        expect(json[0].b).toBe(true);
        expect(json[0].x).toBe(null);
    });

    it('produces output that round-trips through JSON.stringify/parse', () => {
        const json = serializeRowsAsJson(
            ['name', 'age'],
            [['Alice', 30], ['Bob', 25]]
        );
        const text = JSON.stringify(json);
        expect(() => JSON.parse(text)).not.toThrow();
        expect(JSON.parse(text)).toEqual(json);
    });

    it('returns an empty array when there are no rows', () => {
        expect(serializeRowsAsJson(['a'], [])).toEqual([]);
    });

    it('falls back to "Column N" for blank header cells', () => {
        const json = serializeRowsAsJson(['', 'name', ''], [['x', 'Alice', 'y']]);
        expect(json[0]).toEqual({ 'Column 1': 'x', name: 'Alice', 'Column 3': 'y' });
    });

    it('de-duplicates repeated headers with `_2`, `_3`, … suffixes', () => {
        const json = serializeRowsAsJson(
            ['id', 'id', 'id'],
            [[1, 2, 3]]
        );
        expect(Object.keys(json[0])).toEqual(['id', 'id_2', 'id_3']);
        expect(json[0]).toEqual({ id: 1, id_2: 2, id_3: 3 });
    });

    it('fills missing trailing cells with null when row is shorter than headers', () => {
        const json = serializeRowsAsJson(['a', 'b', 'c'], [['x']]);
        expect(json[0]).toEqual({ a: 'x', b: null, c: null });
    });

    it('keeps extra cells under synthetic Column N keys when row is wider', () => {
        const json = serializeRowsAsJson(['a'], [['x', 'y', 'z']]);
        // 'a' is taken by header[0], extras land at synthetic Column 2 / Column 3.
        expect(json[0]).toEqual({ a: 'x', 'Column 2': 'y', 'Column 3': 'z' });
    });

    it('handles ragged rows independently row-by-row', () => {
        const json = serializeRowsAsJson(
            ['a', 'b'],
            [
                ['x'],          // shorter
                ['p', 'q'],     // exact
                ['1', '2', '3'] // longer
            ]
        );
        expect(json).toEqual([
            { a: 'x', b: null },
            { a: 'p', b: 'q' },
            { a: '1', b: '2', 'Column 3': '3' }
        ]);
    });

    it('coerces undefined cells to null so JSON output stays valid', () => {
        const json = serializeRowsAsJson(['a', 'b'], [[undefined, 'x']]);
        const text = JSON.stringify(json);
        expect(JSON.parse(text)).toEqual([{ a: null, b: 'x' }]);
    });

    it('passes object cells through (kept as nested JSON value)', () => {
        const json = serializeRowsAsJson(
            ['payload'],
            [[{ tag: 'special' } as unknown as Row[number]]]
        );
        expect(json[0]).toEqual({ payload: { tag: 'special' } });
        expect(JSON.parse(JSON.stringify(json))).toEqual([{ payload: { tag: 'special' } }]);
    });
});
