// Pure helpers for the Excel viewer's "Toggle View" feature (issue #38).
//
// The orchestrator in `excelViewerMain.ts` owns the DOM, but the *state
// machine* and the *raw payload serializer* live here so they can be
// covered by unit tests without a jsdom shell.
//
// Two concerns:
//   1. `ExcelViewMode` + `toggleViewMode` — the toggle state machine.
//      Trivial today (two states), kept as a named helper so tests can
//      pin the contract and so future "schema view" / "summary view"
//      modes don't break the invariant.
//   2. `serializeSheetForRaw` — turn a `ParsedSheet` into the shape that
//      the raw <pre> displays. We deliberately keep the headers /
//      totalRows / totalColumns metadata in the payload (not just the
//      rows) so the raw view doubles as a "what did the loader see?"
//      debug surface. The output is a plain object literal so
//      `JSON.stringify(payload, null, 2)` is the only thing the caller
//      has to do to render it.

import { ParsedSheet } from './excelLoader';
import { Row } from './excelPagination';

export type ExcelViewMode = 'table' | 'raw';

export function toggleViewMode(mode: ExcelViewMode): ExcelViewMode {
    return mode === 'table' ? 'raw' : 'table';
}

/**
 * The shape that gets serialized into the `<pre>` for the raw view.
 *
 *   - `name`         — sheet name (so the user can tell which sheet they're
 *                      looking at when the workbook has many).
 *   - `headers`      — header row as the loader saw it (may be empty).
 *   - `rows`         — all data rows (NOT filtered, NOT paginated). The raw
 *                      view is the "give me everything" escape hatch; users
 *                      already have search + pagination in the table view.
 *   - `totalRows`    — convenience metadata duplicated from the loader.
 *   - `totalColumns` — same.
 */
export interface RawSheetPayload {
    name: string;
    headers: string[];
    rows: Row[];
    totalRows: number;
    totalColumns: number;
}

export function serializeSheetForRaw(sheet: ParsedSheet | null | undefined): RawSheetPayload {
    if (!sheet) {
        return { name: '', headers: [], rows: [], totalRows: 0, totalColumns: 0 };
    }
    return {
        name: sheet.name,
        headers: (sheet.headers || []).slice(),
        rows: (sheet.rows || []).map((row) => (row || []).slice()),
        totalRows: sheet.totalRows,
        totalColumns: sheet.totalColumns
    };
}

/**
 * `JSON.stringify(serializeSheetForRaw(sheet), null, 2)` in one call —
 * matches the DoD wording ("Raw view is `JSON.stringify(currentSheet, null,
 * 2)` rendered in a `<pre>`") while still going through the serializer so
 * the test contract is honored.
 */
export function renderSheetAsRawJson(sheet: ParsedSheet | null | undefined): string {
    return JSON.stringify(serializeSheetForRaw(sheet), null, 2);
}
