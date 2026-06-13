// Minimal RFC-4180-ish CSV parser used by the Chrome CSV viewer (issue #33).
//
// Scope: just enough to render rows/headers and feed the column-sort. Full
// delimiter detection (#34) and statistics (#35) build on top of this; we
// keep the parser intentionally small (< 200 lines) and pull no npm deps.
//
// What this parser handles:
//   - CRLF / LF / CR line endings (normalized to LF before scanning).
//   - Double-quoted fields with embedded delimiter, embedded newline, and
//     escaped `""` quote characters.
//   - Configurable delimiter (defaults to comma; the future delimiter
//     auto-detect issue #34 will pass `\t` / `;` / `|` here).
//
// What it does NOT handle (deferred):
//   - Comment lines, skip-rows, header-less data conventions.
//   - Streaming: we materialize all rows in memory. CSV files in the browser
//     are usually < 50MB, which fits comfortably.

export interface ParsedCsv {
    headers: string[];
    rows: string[][];
    delimiter: string;
    columnCount: number;
}

export interface ParseOptions {
    delimiter?: string;
    /** When true the first row is taken as headers; otherwise auto-generated. */
    hasHeader?: boolean;
}

/**
 * Parse `text` as CSV. Always returns a stable shape:
 *   - `headers.length === columnCount`
 *   - every row in `rows` is padded / truncated to `columnCount`
 * so downstream consumers (renderer, sort) can index by `[col]` without
 * `undefined` checks.
 */
export function parseCsv(text: string, options: ParseOptions = {}): ParsedCsv {
    const delimiter = options.delimiter ?? ',';
    const hasHeader = options.hasHeader ?? true;

    // Strip BOM so the first header doesn't carry a leading U+FEFF.
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const normalized = stripped.replace(/\r\n?/g, '\n');

    const records: string[][] = [];
    let field = '';
    let row: string[] = [];
    let inQuotes = false;

    for (let i = 0; i < normalized.length; i++) {
        const ch = normalized[i];

        if (inQuotes) {
            if (ch === '"') {
                if (normalized[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }

        if (ch === '"' && field.length === 0) {
            inQuotes = true;
            continue;
        }

        if (ch === delimiter) {
            row.push(field);
            field = '';
            continue;
        }

        if (ch === '\n') {
            row.push(field);
            field = '';
            records.push(row);
            row = [];
            continue;
        }

        field += ch;
    }

    // Flush the last field/row. Drop a trailing empty row that resulted from
    // a final newline so we don't render a phantom blank line.
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        records.push(row);
    }

    if (records.length === 0) {
        return { headers: [], rows: [], delimiter, columnCount: 0 };
    }

    let headers: string[];
    let dataRows: string[][];
    if (hasHeader) {
        headers = records[0];
        dataRows = records.slice(1);
    } else {
        headers = [];
        dataRows = records;
    }

    const columnCount = Math.max(
        headers.length,
        ...dataRows.map((r) => r.length),
        0
    );

    if (!hasHeader) {
        headers = Array.from({ length: columnCount }, (_, i) => `Column ${i + 1}`);
    } else {
        // Pad short header rows so columnCount is consistent.
        while (headers.length < columnCount) {
            headers.push(`Column ${headers.length + 1}`);
        }
    }

    const padded = dataRows.map((r) => {
        if (r.length === columnCount) return r;
        if (r.length > columnCount) return r.slice(0, columnCount);
        const out = r.slice();
        while (out.length < columnCount) out.push('');
        return out;
    });

    return {
        headers,
        rows: padded,
        delimiter,
        columnCount
    };
}
