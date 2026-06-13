// Orchestration layer for the Chrome Parquet viewer (issue #39 base,
// issue #40 search + sort + pagination).
//
// Wires together:
//   - DOM scaffolding (header / body / loading / error states),
//   - the hyparquet ESM lazy loader (`./parquetLoader.ts`),
//   - rows table (#39),
//   - search input + clickable column-header sort + prev/next pagination
//     (#40, helpers in `./parquetSort.ts`).
//
// VSCode -> Chrome substitutions follow the same pattern as the other
// viewers in this repo (#16 PDF, #50 PSD, #53 HWP):
//   - the file is a `File` from the router; we call
//     `await file.arrayBuffer()` instead of reading from disk via `fs`;
//   - hyparquet is loaded via dynamic ESM import from
//     `chrome.runtime.getURL('vendor/hyparquet/index.js')`, gated by our
//     `web_accessible_resources` allowlist;
//   - error paths surface in the inline error panel.
//
// SCOPE for #40: this slice operates on the rows already loaded into
// memory by the parquet bootstrap. We bump the initial fetch from 200 to
// PARQUET_INITIAL_ROW_LIMIT (10k) so search / sort / pagination operate
// on a meaningfully large window. The size guard (#41) and progressive
// loading beyond 10k (#42) remain follow-ups; this slice deliberately
// caps at 10k to keep the responsive-feel target reachable on real
// hardware without paging.

import { PARQUET_VIEWER_CSS } from './parquetViewerStyles';
import { compressors } from 'hyparquet-compressors';
import {
    arrayBufferToAsyncBuffer,
    buildLoadErrorMessage,
    loadHyparquet,
    type AsyncBuffer,
    type HyparquetModule,
    type ParquetFileMetadata,
} from './parquetLoader';
import {
    DEFAULT_ROWS_PER_PAGE,
    applySearch,
    applySort,
    clampPage,
    detectColumnType,
    filterRows,
    getPageSlice,
    nextPage as advancePage,
    nextSortState,
    prevPage as retreatPage,
    totalPageCount,
    type ColumnType,
    type PaginationState,
    type ParquetRow,
    type SortState,
} from './parquetSort';
import {
    formatBlockedMessage,
    formatLimitMessage,
    parquetSizeBucket,
} from './parquetSizeGuard';
import { mountCellContextMenu } from './parquetContextMenu';

const STYLE_ELEMENT_ID = 'omni-viewer-parquet-styles';
/**
 * Bootstrap-fetch row cap for the in-memory parquet slice. The #40 DoD
 * asks "10k rows feel responsive" — we read up to that many rows on
 * mount so the search / sort / pagination pipeline has a meaningful
 * working set. Anything beyond 10k waits for #42 (progressive load).
 */
const PARQUET_INITIAL_ROW_LIMIT = 10_000;

function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = PARQUET_VIEWER_CSS;
    document.head.appendChild(style);
}

export interface ParquetViewerHandle {
    dispose(): void;
}

interface ParquetViewerDom {
    root: HTMLElement;
    title: HTMLElement;
    meta: HTMLElement;
    body: HTMLElement;
    loading: HTMLElement;
    error: HTMLElement;
}

const VIEWER_HTML = /* html */ `
<div class="pv-container" data-parquet-viewer-root>
    <div class="pv-header">
        <div class="pv-title" data-pv-title></div>
        <div class="pv-meta" id="pv-meta"></div>
    </div>
    <div id="pv-loading" class="pv-loading">Loading Parquet&hellip;</div>
    <div id="pv-error" class="pv-error" style="display: none;"></div>
    <div id="pv-body" class="pv-body" style="display: none;"></div>
</div>
`;

function resolveDom(container: HTMLElement): ParquetViewerDom {
    const need = <T extends HTMLElement>(id: string): T => {
        const el = container.querySelector<T>(`#${id}`);
        if (!el) throw new Error(`parquet viewer: missing DOM node #${id}`);
        return el;
    };
    const root = container.querySelector<HTMLElement>('[data-parquet-viewer-root]');
    if (!root) throw new Error('parquet viewer: failed to mount root element');
    const title = root.querySelector<HTMLElement>('[data-pv-title]');
    if (!title) throw new Error('parquet viewer: missing title slot');
    return {
        root,
        title,
        meta: need('pv-meta'),
        body: need('pv-body'),
        loading: need('pv-loading'),
        error: need('pv-error'),
    };
}

function showError(error: HTMLElement, headline: string, detail: string): void {
    error.innerHTML = '';
    const titleEl = document.createElement('div');
    titleEl.className = 'pv-error-title';
    titleEl.textContent = headline;
    const detailEl = document.createElement('div');
    detailEl.className = 'pv-error-detail';
    detailEl.textContent = detail;
    error.append(titleEl, detailEl);
    error.style.display = 'flex';
}

/**
 * Format the metadata badge text for the header (row count + file size).
 * Pure helper exported for tests / future reuse.
 */
export function formatMeta(rowCount: bigint | number, byteLength: number): string {
    const rows = typeof rowCount === 'bigint' ? rowCount : BigInt(rowCount);
    const sizeKB = (byteLength / 1024).toFixed(1);
    const rowsLabel = rows === 1n ? '1 row' : `${rows.toString()} rows`;
    return `${rowsLabel} · ${sizeKB} KB`;
}

/**
 * Render a value into a `<td>` cell. Parquet values can be `null`,
 * `bigint` (INT64), typed arrays (BYTE_ARRAY of bytes), strings, numbers,
 * booleans, or nested objects/arrays. We stringify defensively so a
 * single weird cell never blanks the whole row.
 */
function renderCell(value: unknown): HTMLTableCellElement {
    const td = document.createElement('td');
    if (value === null || value === undefined) {
        td.className = 'pv-cell-null';
        td.textContent = 'null';
        return td;
    }
    if (typeof value === 'bigint') {
        td.className = 'pv-cell-bigint';
        td.textContent = value.toString();
        return td;
    }
    if (typeof value === 'number') {
        td.className = 'pv-cell-number';
        td.textContent = Number.isFinite(value) ? String(value) : String(value);
        return td;
    }
    if (typeof value === 'boolean') {
        td.className = 'pv-cell-bool';
        td.textContent = value ? 'true' : 'false';
        return td;
    }
    if (typeof value === 'string') {
        td.textContent = value;
        return td;
    }
    if (value instanceof Uint8Array) {
        // Render as a short hex preview so users see *something* without
        // dumping potentially-huge binary blobs into the DOM.
        const head = Array.from(value.slice(0, 16))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
        td.textContent = value.length > 16 ? `${head}… (${value.length} bytes)` : head;
        return td;
    }
    // Fallback: JSON-serialize structured values. We supply a replacer
    // that converts BigInt to its decimal string so JSON.stringify doesn't
    // throw. Truncate to a sane preview length so a giant nested object
    // doesn't blow up the table layout.
    try {
        const json = JSON.stringify(value, (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v
        );
        td.textContent = json.length > 200 ? `${json.slice(0, 200)}…` : json;
    } catch {
        td.textContent = String(value);
    }
    return td;
}

/**
 * Decode `file` into hyparquet metadata + the first PARQUET_INITIAL_ROW_LIMIT
 * rows. The cap is a deliberate ceiling for #40 — anything larger waits
 * for #42 (progressive load).
 *
 * NOTE: This still holds the entire file in memory while parsing.
 * Follow-ups #41 (size guard) and #42 (progressive / chunked loading)
 * are required before larger files are safe.
 */
async function loadParquetData(
    mod: HyparquetModule,
    file: File
): Promise<{
    metadata: ParquetFileMetadata;
    rows: ParquetRow[];
    asyncBuffer: AsyncBuffer;
}> {
    // TODO(#42): replace this whole-file slurp with a chunked AsyncBuffer
    // that fetches byte ranges on demand so 50 MB+ files don't pin the
    // main thread. For #40 the synchronous path is correct.
    const arrayBuf = await file.arrayBuffer();
    const asyncBuffer = arrayBufferToAsyncBuffer(arrayBuf);
    const metadata = await mod.parquetMetadataAsync(asyncBuffer);
    const rowEnd =
        metadata.num_rows < BigInt(PARQUET_INITIAL_ROW_LIMIT)
            ? Number(metadata.num_rows)
            : PARQUET_INITIAL_ROW_LIMIT;
    const rows =
        rowEnd > 0
            ? await mod.parquetReadObjects({
                  file: asyncBuffer,
                  metadata,
                  compressors,
                  rowStart: 0,
                  rowEnd,
              })
            : [];
    return { metadata, rows, asyncBuffer };
}

// --- Rows panel rendering (search + sort + pagination) ----------------

/**
 * The rows panel is rebuilt in pieces from a single render pipeline:
 *   raw rows  -> filter (search) -> sort (column click) -> page slice
 * We hold a small `state` object so each user action only invalidates the
 * stages downstream of itself (e.g. "next page" doesn't re-filter; a new
 * search resets to page 1 without re-sorting on a different column).
 *
 * The DOM layout is:
 *   <section.pv-section>
 *     <header>  // section title + row count + search input
 *     <table>   // sortable header + body
 *     <footer>  // prev / page X of N / next
 *   </section>
 *
 * We re-render only `<tbody>` on page changes so 10k rows still feel
 * snappy — only ~200 cells are touched on a paginate.
 */
interface RowsPanelState {
    rawRows: ParquetRow[];
    filteredSortedRows: ParquetRow[];
    columns: string[];
    columnTypes: Map<string, ColumnType>;
    searchTerm: string;
    sort: SortState;
    pagination: PaginationState;
    totalRows: bigint;
}

interface RowsPanelDom {
    section: HTMLElement;
    titleLabel: HTMLElement;
    searchInput: HTMLInputElement;
    clearBtn: HTMLButtonElement;
    tableHeaderRow: HTMLTableRowElement;
    tbody: HTMLTableSectionElement;
    footer: HTMLElement;
    prevBtn: HTMLButtonElement;
    nextBtn: HTMLButtonElement;
    pageInfo: HTMLElement;
}

export interface RowsPanelHandle {
    element: HTMLElement;
    dispose(): void;
    /** The DOM `<table>` so callers can attach a context menu (#42). */
    table: HTMLTableElement;
    /** Append additional rows fetched via progressive loading (#42). */
    appendRows(newRows: ParquetRow[]): void;
    /** Currently visible rows (for column-copy context-menu action). */
    getVisibleRows(): ParquetRow[];
    /** All currently-loaded rows (raw, pre-filter). */
    getAllRows(): ParquetRow[];
    /** Column keys in render order. */
    getColumns(): string[];
    /** Look up the row at the given index inside the current visible slice. */
    getRowAtVisibleIndex(idx: number): ParquetRow | undefined;
}

function buildRowsPanel(
    rows: ParquetRow[],
    totalRows: bigint
): RowsPanelHandle {
    const section = document.createElement('section');
    section.className = 'pv-section';

    if (rows.length === 0) {
        const title = document.createElement('div');
        title.className = 'pv-section-title';
        title.textContent = 'Rows (0)';
        section.appendChild(title);
        const empty = document.createElement('div');
        empty.className = 'pv-cell-null';
        empty.textContent = 'No rows in this file.';
        section.appendChild(empty);
        const emptyTable = document.createElement('table');
        return {
            element: section,
            dispose: () => {},
            table: emptyTable,
            appendRows: () => {},
            getVisibleRows: () => [],
            getAllRows: () => [],
            getColumns: () => [],
            getRowAtVisibleIndex: () => undefined,
        };
    }

    // Header row — section title + result count + search input + clear.
    const header = document.createElement('div');
    header.className = 'pv-rows-header';

    const titleLabel = document.createElement('div');
    titleLabel.className = 'pv-section-title pv-rows-title';
    header.appendChild(titleLabel);

    const searchWrap = document.createElement('div');
    searchWrap.className = 'pv-search-wrap';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'pv-search-input';
    searchInput.placeholder = 'Search rows…';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'pv-btn';
    clearBtn.textContent = 'Clear';
    searchWrap.append(searchInput, clearBtn);
    header.appendChild(searchWrap);
    section.appendChild(header);

    // Build the rows table.
    const wrap = document.createElement('div');
    wrap.className = 'pv-rows-wrap';
    const table = document.createElement('table');
    table.className = 'pv-rows-table';

    // Build the header from the first row's keys (parquet rows are
    // uniformly shaped, so reading row[0] is enough).
    const columns = Object.keys(rows[0]);
    const thead = document.createElement('thead');
    const tableHeaderRow = document.createElement('tr');
    thead.appendChild(tableHeaderRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    wrap.appendChild(table);
    section.appendChild(wrap);

    // Footer: prev / page X of N / next.
    const footer = document.createElement('div');
    footer.className = 'pv-pagination';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'pv-btn';
    prevBtn.textContent = '← Previous';
    const pageInfo = document.createElement('span');
    pageInfo.className = 'pv-page-info';
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'pv-btn';
    nextBtn.textContent = 'Next →';
    footer.append(prevBtn, pageInfo, nextBtn);
    section.appendChild(footer);

    const dom: RowsPanelDom = {
        section,
        titleLabel,
        searchInput,
        clearBtn,
        tableHeaderRow,
        tbody,
        footer,
        prevBtn,
        nextBtn,
        pageInfo
    };

    const state: RowsPanelState = {
        rawRows: rows,
        filteredSortedRows: rows.slice(),
        columns,
        columnTypes: new Map(),
        searchTerm: '',
        sort: { columnKey: null, direction: null },
        pagination: {
            page: 1,
            rowsPerPage: DEFAULT_ROWS_PER_PAGE,
            totalRows: rows.length
        },
        totalRows
    };

    // ------ rendering pieces -----------------------------------------

    /**
     * Re-render the table header. Each <th> shows the column name plus a
     * sort indicator (▲ / ▼ / unsorted dot). Clicking the <th> cycles the
     * sort state for that column.
     */
    function renderHeader(): void {
        tableHeaderRow.innerHTML = '';
        for (const col of state.columns) {
            const th = document.createElement('th');
            th.className = 'pv-th-sortable';
            th.dataset.column = col;

            const inner = document.createElement('span');
            inner.className = 'pv-th-inner';
            const labelEl = document.createElement('span');
            labelEl.className = 'pv-th-label';
            labelEl.textContent = col;
            const indicator = document.createElement('span');
            indicator.className = 'pv-th-sort-indicator';
            if (state.sort.columnKey === col && state.sort.direction === 'asc') {
                indicator.textContent = '▲';
                th.classList.add('pv-th-sorted-asc');
            } else if (
                state.sort.columnKey === col &&
                state.sort.direction === 'desc'
            ) {
                indicator.textContent = '▼';
                th.classList.add('pv-th-sorted-desc');
            } else {
                indicator.textContent = '⇅';
            }
            inner.append(labelEl, indicator);
            th.appendChild(inner);
            tableHeaderRow.appendChild(th);
        }
    }

    /** Re-render the visible page of rows. */
    function renderBody(): void {
        tbody.innerHTML = '';
        const slice = getPageSlice(state.filteredSortedRows, state.pagination);
        currentVisibleSlice = slice.rows;
        for (let visIdx = 0; visIdx < slice.rows.length; visIdx++) {
            const row = slice.rows[visIdx];
            const tr = document.createElement('tr');
            tr.dataset.rowIndex = String(visIdx);
            for (let colIdx = 0; colIdx < state.columns.length; colIdx++) {
                const col = state.columns[colIdx];
                const cell = renderCell(row[col]);
                cell.dataset.colIndex = String(colIdx);
                tr.appendChild(cell);
            }
            tbody.appendChild(tr);
        }
    }
    let currentVisibleSlice: ParquetRow[] = [];

    /** Re-render the section title (count) + footer (page info). */
    function renderChrome(): void {
        const filteredCount = state.filteredSortedRows.length;
        const filterActive = state.searchTerm.trim().length > 0;
        const totalAvailable = state.rawRows.length;
        const totalKnown = state.totalRows;

        let label: string;
        if (filterActive) {
            label = `Rows (${filteredCount.toLocaleString()} of ${totalAvailable.toLocaleString()} matching)`;
        } else if (totalKnown > BigInt(totalAvailable)) {
            label = `Rows (showing ${totalAvailable.toLocaleString()} of ${totalKnown.toString()})`;
        } else {
            label = `Rows (${totalAvailable.toLocaleString()})`;
        }
        titleLabel.textContent = label;

        const totalPages = totalPageCount(state.pagination);
        pageInfo.textContent = `Page ${state.pagination.page} of ${totalPages}`;
        prevBtn.disabled = state.pagination.page <= 1;
        nextBtn.disabled = state.pagination.page >= totalPages;
        footer.style.display = filteredCount > 0 ? 'flex' : 'none';
    }

    /**
     * Recompute `filteredSortedRows` from rawRows according to current
     * search + sort. Caller is responsible for clamping the page (we
     * usually reset to page 1 from the caller — search reset, sort change
     * — but a paginate-only update doesn't need to recompute this).
     */
    function recomputeFilteredSorted(): void {
        const filtered = filterRows(state.rawRows, state.searchTerm);
        const sorted = applySort(
            filtered,
            state.sort,
            state.sort.columnKey
                ? state.columnTypes.get(state.sort.columnKey)
                : undefined
        );
        state.filteredSortedRows = sorted;
        state.pagination = {
            ...state.pagination,
            totalRows: sorted.length,
            page: clampPage({ ...state.pagination, totalRows: sorted.length })
        };
    }

    function fullRerender(): void {
        renderHeader();
        renderBody();
        renderChrome();
    }

    // ------ event handlers -------------------------------------------

    const onHeaderClick = (e: MouseEvent): void => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const th = target.closest<HTMLTableCellElement>('.pv-th-sortable');
        if (!th) return;
        const col = th.dataset.column;
        if (!col) return;

        // Detect column type the first time we sort it; cache for reuse so
        // re-clicks don't re-walk the column.
        if (!state.columnTypes.has(col)) {
            const sample = state.rawRows.map((r) => r[col]);
            state.columnTypes.set(col, detectColumnType(sample));
        }

        state.sort = nextSortState(state.sort, col);
        // Sort change keeps the search but resets to page 1 — the user just
        // re-ordered the result set, so showing them the new "first page"
        // is the natural behavior.
        state.pagination = { ...state.pagination, page: 1 };
        recomputeFilteredSorted();
        fullRerender();
    };

    const onSearchInput = (): void => {
        state.searchTerm = searchInput.value;
        const result = applySearch(
            applySort(
                state.rawRows,
                state.sort,
                state.sort.columnKey
                    ? state.columnTypes.get(state.sort.columnKey)
                    : undefined
            ),
            state.searchTerm,
            state.pagination.rowsPerPage
        );
        state.filteredSortedRows = result.filtered;
        state.pagination = result.pagination;
        renderBody();
        renderChrome();
    };

    const onClearSearch = (): void => {
        if (!searchInput.value && !state.searchTerm) return;
        searchInput.value = '';
        state.searchTerm = '';
        // Clearing search returns to the (sorted) full set, page 1.
        state.filteredSortedRows = applySort(
            state.rawRows,
            state.sort,
            state.sort.columnKey
                ? state.columnTypes.get(state.sort.columnKey)
                : undefined
        );
        state.pagination = {
            ...state.pagination,
            page: 1,
            totalRows: state.filteredSortedRows.length
        };
        renderBody();
        renderChrome();
    };

    const onPrev = (): void => {
        const next = retreatPage(state.pagination);
        if (next.page === state.pagination.page) return;
        state.pagination = next;
        renderBody();
        renderChrome();
    };

    const onNext = (): void => {
        const next = advancePage(state.pagination);
        if (next.page === state.pagination.page) return;
        state.pagination = next;
        renderBody();
        renderChrome();
    };

    tableHeaderRow.addEventListener('click', onHeaderClick);
    searchInput.addEventListener('input', onSearchInput);
    clearBtn.addEventListener('click', onClearSearch);
    prevBtn.addEventListener('click', onPrev);
    nextBtn.addEventListener('click', onNext);

    fullRerender();

    return {
        element: section,
        dispose(): void {
            tableHeaderRow.removeEventListener('click', onHeaderClick);
            searchInput.removeEventListener('input', onSearchInput);
            clearBtn.removeEventListener('click', onClearSearch);
            prevBtn.removeEventListener('click', onPrev);
            nextBtn.removeEventListener('click', onNext);
        },
        table,
        appendRows(newRows: ParquetRow[]): void {
            if (!newRows || newRows.length === 0) return;
            state.rawRows = state.rawRows.concat(newRows);
            recomputeFilteredSorted();
            fullRerender();
        },
        getVisibleRows(): ParquetRow[] {
            return currentVisibleSlice;
        },
        getAllRows(): ParquetRow[] {
            return state.rawRows;
        },
        getColumns(): string[] {
            return state.columns;
        },
        getRowAtVisibleIndex(idx: number): ParquetRow | undefined {
            return currentVisibleSlice[idx];
        },
    };
}

/**
 * Mount the Parquet viewer into `container`. Returns synchronously with a
 * handle whose `dispose()` cleans up; the actual hyparquet load + parse
 * happen in the background and the loading / error UI reacts to it.
 */
export function mountParquetViewer(
    file: File,
    container: HTMLElement
): ParquetViewerHandle {
    ensureStylesInjected();
    container.innerHTML = VIEWER_HTML;

    const dom = resolveDom(container);
    dom.title.textContent = file.name;

    let disposed = false;
    let rowsPanelDispose: (() => void) | undefined;
    let contextMenuDispose: (() => void) | undefined;
    let parityControlsDispose: (() => void) | undefined;

    // Issue #41 — refuse to even fetch bytes for files at or above the
    // block threshold; the user gets a friendly panel + a Download link.
    const bucket = parquetSizeBucket(file.size);
    if (bucket === 'blocked') {
        const blockMsg = formatBlockedMessage(file.size);
        dom.loading.style.display = 'none';
        dom.body.innerHTML = '';
        const panel = document.createElement('section');
        panel.className = 'pv-section pv-block-panel';
        const headline = document.createElement('div');
        headline.className = 'pv-section-title';
        headline.textContent = blockMsg.headline;
        const detail = document.createElement('p');
        detail.className = 'pv-block-detail';
        detail.textContent = blockMsg.detail;
        const downloadUrl = URL.createObjectURL(file);
        const dlBtn = document.createElement('a');
        dlBtn.className = 'pv-btn pv-btn-primary';
        dlBtn.href = downloadUrl;
        dlBtn.download = file.name;
        dlBtn.textContent = `Download ${file.name}`;
        panel.append(headline, detail, dlBtn);
        dom.body.appendChild(panel);
        dom.body.style.display = 'flex';
        return {
            dispose(): void {
                disposed = true;
                try {
                    URL.revokeObjectURL(downloadUrl);
                } catch {
                    // best-effort
                }
            },
        };
    }

    void (async () => {
        try {
            // Two distinct failure modes — surface them with different
            // headlines so the user can tell whether the bundle failed
            // to load or a specific file is malformed.
            let mod: HyparquetModule;
            try {
                mod = await loadHyparquet();
            } catch (err) {
                if (disposed) return;
                dom.loading.style.display = 'none';
                showError(
                    dom.error,
                    "Couldn't load Parquet reader",
                    buildLoadErrorMessage(err)
                );
                return;
            }
            if (disposed) return;

            const { metadata, rows, asyncBuffer } = await loadParquetData(mod, file);
            if (disposed) return;

            dom.meta.textContent = formatMeta(metadata.num_rows, file.size);
            dom.body.innerHTML = '';
            const rowsPanel = buildRowsPanel(rows, metadata.num_rows);
            rowsPanelDispose = rowsPanel.dispose;
            const parityControls = buildParityControls(rowsPanel);
            parityControlsDispose = parityControls.dispose;
            rowsPanel.element.querySelector('.pv-rows-header')?.appendChild(parityControls.element);
            dom.body.appendChild(rowsPanel.element);

            // Issue #42 — Load more + progress for files that have more
            // rows than we've fetched so far.
            const totalRowsBig = metadata.num_rows;
            const loadMoreUI = buildLoadMoreUI(rowsPanel, mod, asyncBuffer, totalRowsBig, bucket);
            if (loadMoreUI) {
                rowsPanel.element.appendChild(loadMoreUI);
            }

            // Issue #42 — right-click cell context menu (Copy cell / column /
            // row as JSON).
            const ctx = mountCellContextMenu({
                table: rowsPanel.table,
                getVisibleRows: () => parquetRowsToArrays(rowsPanel.getVisibleRows(), rowsPanel.getColumns()),
                getHeaders: () => rowsPanel.getColumns(),
                getRowAt: (idx) => {
                    const row = rowsPanel.getRowAtVisibleIndex(idx);
                    return row ? rowsPanel.getColumns().map((c) => row[c]) : undefined;
                },
                writeText: (text) => {
                    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                        return navigator.clipboard.writeText(text).catch(() => undefined);
                    }
                    return undefined;
                },
            });
            contextMenuDispose = ctx.dispose;

            dom.loading.style.display = 'none';
            dom.body.style.display = 'flex';
        } catch (err) {
            if (disposed) return;
            const message = err instanceof Error ? err.message : String(err);
            dom.loading.style.display = 'none';
            showError(dom.error, 'Failed to render Parquet', message);
        }
    })();

    return {
        dispose(): void {
            disposed = true;
            contextMenuDispose?.();
            contextMenuDispose = undefined;
            rowsPanelDispose?.();
            rowsPanelDispose = undefined;
            parityControlsDispose?.();
            parityControlsDispose = undefined;
        },
    };
}

function buildParityControls(rowsPanel: RowsPanelHandle): { element: HTMLElement; dispose(): void } {
    const wrap = document.createElement('div');
    wrap.className = 'pv-parity-controls';
    const copyTable = document.createElement('button'); copyTable.type = 'button'; copyTable.className = 'pv-btn'; copyTable.textContent = '📋 Copy to Clipboard';
    const copyJson = document.createElement('button'); copyJson.type = 'button'; copyJson.className = 'pv-btn'; copyJson.textContent = '📄 Copy JSON';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'pv-btn'; toggle.textContent = '📊 Toggle View';
    const raw = document.createElement('pre'); raw.className = 'pv-raw-view'; raw.style.display = 'none';
    const copyText = (value: string) => navigator.clipboard?.writeText(value).catch(() => undefined);
    const onCopyTable = () => {
        const columns = rowsPanel.getColumns();
        const lines = [columns.join('\t'), ...rowsPanel.getVisibleRows().map((row) => columns.map((column) => String(row[column] ?? '')).join('\t'))];
        void copyText(lines.join('\n'));
    };
    const onCopyJson = () => { void copyText(JSON.stringify(rowsPanel.getVisibleRows(), null, 2)); };
    const onToggle = () => {
        const visible = raw.style.display !== 'none';
        raw.style.display = visible ? 'none' : 'block';
        rowsPanel.element.style.display = visible ? '' : 'none';
        toggle.textContent = '📊 Toggle View';
        if (!visible) raw.textContent = JSON.stringify(rowsPanel.getAllRows(), null, 2);
    };
    copyTable.addEventListener('click', onCopyTable); copyJson.addEventListener('click', onCopyJson); toggle.addEventListener('click', onToggle);
    wrap.append(copyTable, copyJson, toggle, raw);
    return { element: wrap, dispose(): void { copyTable.removeEventListener('click', onCopyTable); copyJson.removeEventListener('click', onCopyJson); toggle.removeEventListener('click', onToggle); } };
}

/**
 * Build the limit-warning + Load-more UI panel for the current rows panel.
 * Returns null when there's nothing to load (rawRows already cover the
 * total). The panel updates its progress text after each successful load.
 */
function buildLoadMoreUI(
    rowsPanel: RowsPanelHandle,
    mod: HyparquetModule,
    asyncBuffer: AsyncBuffer,
    totalRows: bigint,
    bucket: 'small' | 'limited'
): HTMLElement | null {
    const loaded = BigInt(rowsPanel.getAllRows().length);
    if (loaded >= totalRows) return null;

    const wrap = document.createElement('div');
    wrap.className = bucket === 'limited' ? 'pv-limit-warning' : 'pv-load-more';

    const message = document.createElement('div');
    message.className = 'pv-limit-message';
    message.textContent = formatLimitMessage(rowsPanel.getAllRows().length, totalRows);
    wrap.appendChild(message);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pv-btn pv-btn-primary';
    btn.textContent = 'Load Next 10,000 Rows';
    wrap.appendChild(btn);

    let inFlight = false;
    btn.addEventListener('click', async () => {
        if (inFlight) return;
        const currentLoaded = BigInt(rowsPanel.getAllRows().length);
        if (currentLoaded >= totalRows) return;
        inFlight = true;
        btn.disabled = true;
        btn.textContent = 'Loading…';
        try {
            const rowStart = Number(currentLoaded);
            const rowEnd = Math.min(rowStart + 10_000, Number(totalRows));
            const fresh = await mod.parquetReadObjects({
                file: asyncBuffer,
                compressors,
                rowStart,
                rowEnd,
            });
            rowsPanel.appendRows(fresh as ParquetRow[]);
            const nextLoaded = rowsPanel.getAllRows().length;
            message.textContent = formatLimitMessage(nextLoaded, totalRows);
            if (BigInt(nextLoaded) >= totalRows) {
                btn.remove();
            } else {
                btn.disabled = false;
                btn.textContent = 'Load Next 10,000 Rows';
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            message.textContent = `Failed to load more rows: ${msg}`;
            btn.disabled = false;
            btn.textContent = 'Retry';
        } finally {
            inFlight = false;
        }
    });

    return wrap;
}

/**
 * Convert a visible slice of `ParquetRow` (object form) into row arrays
 * keyed by column order, so the context menu's pure helpers can stay
 * row-as-array.
 */
function parquetRowsToArrays(rows: ParquetRow[], columns: string[]): unknown[][] {
    return rows.map((row) => columns.map((c) => row[c]));
}

// Re-exports for tests / callers that want the helpers without pulling in
// the full mount.
export {
    buildRowsPanel,
    renderCell,
    PARQUET_INITIAL_ROW_LIMIT,
};
