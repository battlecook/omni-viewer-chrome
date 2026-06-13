// Pure serializers for the Excel viewer's Copy / Copy-as-JSON toolbar
// buttons (issue #37).
//
// Both helpers operate on the *currently visible filtered rows* — the
// caller is expected to pass `sheetCache.get(idx).filtered`, NOT the raw
// workbook rows. Headers come from the parsed sheet so the output stays
// aligned with what the user sees in the table.
//
// We deliberately reuse `stringifyCell` from `excelPagination.ts` so a
// cell value renders the same way whether it's painted into the DOM,
// matched by search, or copied to the clipboard.

import { CellValue, Row, stringifyCell } from './excelPagination';

/**
 * TSV escape strategy:
 *
 *   - Cells containing TAB, NEWLINE (\n / \r), or DOUBLE QUOTE are wrapped
 *     in double quotes (`"…"`) and any embedded `"` is doubled to `""`,
 *     mirroring RFC-4180-style escaping but with `\t` as the column
 *     separator. This is the same convention Excel and Google Sheets use
 *     when round-tripping clipboard TSV.
 *   - Cells that don't contain any of those control characters are emitted
 *     as-is (no quoting) so the typical case stays clean.
 *   - `null` / `undefined` cells become empty strings via `stringifyCell`,
 *     same as the on-screen rendering.
 *   - Object cells are JSON-stringified by `stringifyCell` first, then run
 *     through the same escape pass (the JSON itself contains `"`, so it
 *     will get quoted + doubled here).
 *   - Rows are joined with `\n` (no trailing newline). Header / row column
 *     count mismatches are tolerated: shorter rows get blank trailing
 *     cells, longer rows keep their extra columns (the source workbook
 *     can have ragged data and we don't want to silently drop it).
 */
export function serializeRowsAsTsv(headers: readonly string[], rows: readonly Row[]): string {
    const headerCells = headers.map((h) => escapeTsvCell(h ?? ''));
    const columnCount = headerCells.length;
    const lines: string[] = [headerCells.join('\t')];
    for (const row of rows) {
        const safeRow: Row = row || [];
        const rowLength = Math.max(columnCount, safeRow.length);
        const cells: string[] = [];
        for (let i = 0; i < rowLength; i++) {
            cells.push(escapeTsvCell(stringifyCell(safeRow[i])));
        }
        lines.push(cells.join('\t'));
    }
    return lines.join('\n');
}

/**
 * Build an array of plain `{ header: value }` objects from the visible
 * filtered rows. Used by the "Copy as JSON" button — the result is fed
 * into `JSON.stringify(..., null, 2)` for clipboard output.
 *
 *   - Each header column produces a key in every row's object. Headers
 *     are de-duplicated by suffixing `_2`, `_3`, … so the JSON keys stay
 *     unique even if the source sheet has repeated header labels.
 *   - Blank header cells fall back to `Column N` (1-based) so the JSON
 *     stays valid even on sheets with no header row.
 *   - Cell values keep their original primitive type when possible
 *     (number / boolean / null), only objects are passed through as-is
 *     and strings stay strings. This preserves more fidelity than the
 *     TSV path (which always stringifies).
 *   - Header / row mismatch handling: if a row has *fewer* cells than
 *     headers, the missing trailing keys map to `null`. If a row has
 *     *more* cells than headers, the extra cells are emitted under
 *     synthetic `Column N` keys so the data isn't dropped.
 */
export function serializeRowsAsJson(headers: readonly string[], rows: readonly Row[]): Array<Record<string, CellValue>> {
    const headerKeys = buildUniqueHeaderKeys(headers);
    return rows.map((row) => {
        const safeRow: Row = row || [];
        const obj: Record<string, CellValue> = {};
        const usedKeys = new Set<string>(headerKeys);
        const columnCount = Math.max(headerKeys.length, safeRow.length);
        for (let i = 0; i < columnCount; i++) {
            let key: string;
            if (i < headerKeys.length) {
                key = headerKeys[i];
            } else {
                key = uniqueColumnLabel(usedKeys, i);
                usedKeys.add(key);
            }
            obj[key] = i < safeRow.length ? safeRow[i] ?? null : null;
        }
        return obj;
    });
}

// --- internals ----------------------------------------------------------

const TSV_ESCAPE_TRIGGERS = /[\t\r\n"]/;

function escapeTsvCell(raw: string): string {
    if (!TSV_ESCAPE_TRIGGERS.test(raw)) return raw;
    return `"${raw.replace(/"/g, '""')}"`;
}

function defaultColumnLabel(zeroBasedIndex: number): string {
    return `Column ${zeroBasedIndex + 1}`;
}

function buildUniqueHeaderKeys(headers: readonly string[]): string[] {
    const seen = new Map<string, number>();
    const result: string[] = [];
    headers.forEach((header, index) => {
        const base = (header ?? '').toString().trim() || defaultColumnLabel(index);
        result.push(reserveKey(seen, base));
    });
    return result;
}

function reserveKey(seen: Map<string, number>, base: string): string {
    const count = seen.get(base) ?? 0;
    if (count === 0) {
        seen.set(base, 1);
        return base;
    }
    let candidate = `${base}_${count + 1}`;
    let nextCount = count + 1;
    // Avoid colliding with another header that legitimately had `_n` suffix.
    while (seen.has(candidate)) {
        nextCount++;
        candidate = `${base}_${nextCount}`;
    }
    seen.set(base, nextCount);
    seen.set(candidate, 1);
    return candidate;
}

function uniqueColumnLabel(used: ReadonlySet<string>, zeroBasedIndex: number): string {
    const base = defaultColumnLabel(zeroBasedIndex);
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
}
