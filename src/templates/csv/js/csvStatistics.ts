// CSV statistics + clipboard helpers (issue #35).
//
// Pure / DOM-less utilities that the viewer module wires up for the
// "Statistics" panel and the Ctrl+C copy-as-TSV shortcut. Keeping everything
// outside the DOM makes these helpers trivially unit-testable under jsdom.
//
// Contracts
// ---------
// `computeStatistics(rows, headers)` returns one `ColumnStats` per header
// (so callers can index by column position even when a column is empty):
//
//   - `total` always equals `rows.length`.
//   - `nullCount` counts cells that are missing entirely or are
//     whitespace-only after `.trim()`. `nullPercent` is `nullCount / total`
//     in [0, 1] (0 when `total === 0`).
//   - `numeric` is populated only when the column qualifies as numeric:
//     at least one non-empty value AND every non-empty value parses to a
//     finite `Number`. Otherwise `numeric` is `null`. Mean / min / max are
//     computed over the numeric (non-empty) values only — null cells do not
//     drag the mean down to zero.
//   - `count` is the number of non-empty (non-null) cells.
//
// `serializeRowsToTsv(rows, headers?)` produces a TSV string suitable for
// `navigator.clipboard.writeText`. Each cell is escaped: tabs, CR, LF, and
// embedded `"` flip the cell into double-quoted form with `""` escaping
// (matching the convention spreadsheets understand when pasting back). When
// `headers` is provided it is emitted as the first record.

export interface NumericStats {
    /** Number of non-empty cells contributing to the numeric stats. */
    count: number;
    mean: number;
    min: number;
    max: number;
}

export interface ColumnStats {
    /** Header label (empty string if unnamed). */
    header: string;
    /** Column index in the row tuple. */
    columnIndex: number;
    /** Total number of rows considered (== rows.length). */
    total: number;
    /** Non-empty cells in this column. */
    count: number;
    /** Cells that are missing or whitespace-only. */
    nullCount: number;
    /** nullCount / total in [0, 1]; 0 when total === 0. */
    nullPercent: number;
    /** Populated only when the column qualifies as numeric. */
    numeric: NumericStats | null;
}

/**
 * A cell is "null" (empty) when it is `undefined`, `null`, or trims to an
 * empty string. This matches the behavior the sort module uses to push empty
 * values to the bottom regardless of direction.
 */
export function isNullCell(value: string | undefined | null): boolean {
    if (value === undefined || value === null) return true;
    return value.trim().length === 0;
}

/**
 * Try to interpret a cell as a finite number. Returns `null` when the trimmed
 * value does not parse via `Number(...)` to a finite value. Empty cells return
 * `null` (callers should pre-filter via `isNullCell` if they want to distinguish
 * "empty" from "non-numeric").
 */
export function parseNumericCell(value: string | undefined | null): number | null {
    if (isNullCell(value)) return null;
    const trimmed = (value as string).trim();
    // Number('') is 0 but isNullCell already returned true for empty/whitespace.
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
}

/**
 * Returns true when at least one non-empty cell exists AND every non-empty
 * cell parses to a finite number. An entirely-empty column is NOT numeric
 * (we can't say either way, and downstream code expects `numeric === null`).
 */
export function isNumericColumn(values: ReadonlyArray<string | undefined | null>): boolean {
    let nonEmpty = 0;
    for (const v of values) {
        if (isNullCell(v)) continue;
        nonEmpty++;
        if (parseNumericCell(v) === null) return false;
    }
    return nonEmpty > 0;
}

/**
 * Compute statistics for every header column.
 *
 * Empty / under-sized rows are tolerated: a missing cell is treated as
 * `null`. Extra cells beyond `headers.length` are ignored (callers typically
 * pad rows before getting here, but we don't rely on it).
 */
export function computeStatistics(
    rows: ReadonlyArray<ReadonlyArray<string | undefined | null>>,
    headers: ReadonlyArray<string>
): ColumnStats[] {
    const total = rows.length;
    const out: ColumnStats[] = [];

    for (let col = 0; col < headers.length; col++) {
        const header = headers[col] ?? '';
        let nullCount = 0;
        let count = 0;
        const numericValues: number[] = [];
        let allNonEmptyNumeric = true;

        for (let r = 0; r < total; r++) {
            const cell = rows[r] ? rows[r][col] : undefined;
            if (isNullCell(cell)) {
                nullCount++;
                continue;
            }
            count++;
            const n = parseNumericCell(cell);
            if (n === null) {
                allNonEmptyNumeric = false;
            } else {
                numericValues.push(n);
            }
        }

        const nullPercent = total === 0 ? 0 : nullCount / total;

        let numeric: NumericStats | null = null;
        if (allNonEmptyNumeric && numericValues.length > 0) {
            let min = numericValues[0];
            let max = numericValues[0];
            let sum = 0;
            for (const v of numericValues) {
                if (v < min) min = v;
                if (v > max) max = v;
                sum += v;
            }
            numeric = {
                count: numericValues.length,
                mean: sum / numericValues.length,
                min,
                max
            };
        }

        out.push({
            header,
            columnIndex: col,
            total,
            count,
            nullCount,
            nullPercent,
            numeric
        });
    }

    return out;
}

/**
 * Escape a single cell for TSV output. We only need to quote the cell when it
 * contains a tab, CR, LF, or a `"` — pasting into Excel / Google Sheets then
 * round-trips the value cleanly. The escape rule is the same as RFC-4180 for
 * CSV: surround in double quotes, double up any internal `"`.
 */
export function escapeTsvCell(value: string | undefined | null): string {
    const v = value == null ? '' : String(value);
    if (v.length === 0) return '';
    const needsQuoting = /[\t\r\n"]/.test(v);
    if (!needsQuoting) return v;
    return '"' + v.replace(/"/g, '""') + '"';
}

/**
 * Serialize rows (and optionally a header row) to a TSV string. Always uses
 * `\n` as the row separator to keep the output platform-stable; spreadsheet
 * apps accept LF on paste.
 */
export function serializeRowsToTsv(
    rows: ReadonlyArray<ReadonlyArray<string | undefined | null>>,
    headers?: ReadonlyArray<string>
): string {
    const lines: string[] = [];
    if (headers && headers.length > 0) {
        lines.push(headers.map(escapeTsvCell).join('\t'));
    }
    for (const row of rows) {
        lines.push(row.map(escapeTsvCell).join('\t'));
    }
    return lines.join('\n');
}

/**
 * Format a number for the statistics panel UI. We keep this in the helpers
 * file so the formatting choice (max 4 fractional digits, no trailing zeros)
 * stays unit-testable.
 */
export function formatStatNumber(value: number): string {
    if (!Number.isFinite(value)) return '—';
    if (Number.isInteger(value)) return String(value);
    // Up to 4 fractional digits; strip trailing zeros for readability.
    const s = value.toFixed(4);
    return s.replace(/\.?0+$/, '');
}

/**
 * Format a 0..1 fraction as a percentage with up to one decimal place.
 */
export function formatPercent(fraction: number): string {
    if (!Number.isFinite(fraction)) return '—';
    const pct = fraction * 100;
    if (Number.isInteger(pct)) return `${pct}%`;
    return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
}
