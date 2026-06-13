// Pure pagination + search helpers for the Excel viewer (issue #36).
//
// Kept side-effect-free so the main orchestrator stays small and the test
// suite covers the math without DOM mocking.

export type CellValue = string | number | boolean | null | undefined | object;
export type Row = CellValue[];

export interface PaginationState {
    page: number;        // 1-based
    rowsPerPage: number; // > 0
    totalRows: number;
}

export interface PageSlice {
    rows: Row[];
    startIndex: number; // 0-based inclusive
    endIndex: number;   // 0-based exclusive
}

export const DEFAULT_ROWS_PER_PAGE = 200;

export function clampPage(state: PaginationState): number {
    const totalPages = totalPageCount(state);
    if (state.page < 1) return 1;
    if (state.page > totalPages) return totalPages;
    return state.page;
}

export function totalPageCount(state: PaginationState): number {
    if (state.totalRows <= 0 || state.rowsPerPage <= 0) return 1;
    return Math.max(1, Math.ceil(state.totalRows / state.rowsPerPage));
}

export function getPageSlice(rows: Row[], state: PaginationState): PageSlice {
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

/**
 * Case-insensitive "contains" filter across every cell. Mirrors the VSCode
 * original `rowMatchesSearch` (object cells become `JSON.stringify`).
 */
export function rowMatchesSearch(row: Row | undefined | null, searchTerm: string): boolean {
    if (!searchTerm) return true;
    const needle = searchTerm.toLowerCase();
    if (!row || row.length === 0) return false;
    return row.some((cell) => stringifyCell(cell).toLowerCase().includes(needle));
}

export function stringifyCell(cell: CellValue): string {
    if (cell === null || cell === undefined) return '';
    if (typeof cell === 'object') {
        try {
            return JSON.stringify(cell);
        } catch {
            return '';
        }
    }
    return String(cell);
}

export function filterRows(rows: Row[], searchTerm: string): Row[] {
    if (!searchTerm) return rows.slice();
    return rows.filter((row) => rowMatchesSearch(row, searchTerm));
}

export interface ApplySearchResult {
    filtered: Row[];
    pagination: PaginationState;
}

/**
 * Run a search and return the filtered set + a fresh pagination state
 * pinned to page 1 (DoD: "search resets pagination to page 1").
 */
export function applySearch(rows: Row[], searchTerm: string, rowsPerPage = DEFAULT_ROWS_PER_PAGE): ApplySearchResult {
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

export function nextPage(state: PaginationState): PaginationState {
    const totalPages = totalPageCount(state);
    return { ...state, page: Math.min(totalPages, state.page + 1) };
}

export function prevPage(state: PaginationState): PaginationState {
    return { ...state, page: Math.max(1, state.page - 1) };
}
