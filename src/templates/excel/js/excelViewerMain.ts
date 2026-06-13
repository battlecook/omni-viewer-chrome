// Orchestration layer for the Chrome Excel viewer (issue #36 — search +
// pagination + sheet switch + parse, issue #37 — copy / copy-as-JSON
// toolbar, issue #38 — Toggle View (raw JSON) + meta info wiring).

import { EXCEL_VIEWER_CSS } from './excelViewerStyles';
import { parseWorkbookFromFile, ParsedSheet, ParsedWorkbook } from './excelLoader';
import {
    DEFAULT_ROWS_PER_PAGE,
    PaginationState,
    Row,
    applySearch,
    filterRows,
    getPageSlice,
    nextPage,
    prevPage,
    rowMatchesSearch,
    stringifyCell,
    totalPageCount
} from './excelPagination';
import { serializeRowsAsJson, serializeRowsAsTsv } from './excelExport';
import { ExcelViewMode, renderSheetAsRawJson, toggleViewMode } from './excelRawToggle';

const STYLE_ELEMENT_ID = 'omni-viewer-excel-styles';

function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = EXCEL_VIEWER_CSS;
    document.head.appendChild(style);
}

interface ExcelDom {
    title: HTMLElement;
    sheetInfo: HTMLElement;
    rowCount: HTMLElement;
    columnCount: HTMLElement;
    fileSize: HTMLElement;
    sheetSelect: HTMLSelectElement;
    searchInput: HTMLInputElement;
    clearSearchBtn: HTMLButtonElement;
    copyTsvBtn: HTMLButtonElement;
    copyJsonBtn: HTMLButtonElement;
    toggleViewBtn: HTMLButtonElement;
    loading: HTMLElement;
    error: HTMLElement;
    tableContainer: HTMLElement;
    tableWrapper: HTMLElement;
    tableHeader: HTMLElement;
    tableBody: HTMLElement;
    rawWrapper: HTMLElement;
    rawData: HTMLElement;
    pagination: HTMLElement;
    prevPageBtn: HTMLButtonElement;
    nextPageBtn: HTMLButtonElement;
    pageInfo: HTMLElement;
}

export interface ExcelViewerHandle {
    dispose(): void;
}

const VIEWER_HTML = /* html */ `
<div class="xv-container" data-excel-viewer-root>
    <div class="xv-header">
        <div class="xv-title" data-xv-title>📊</div>
        <div class="xv-file-info">
            <span id="xv-sheetInfo">Sheet 1</span> •
            <span id="xv-rowCount">0 rows</span> •
            <span id="xv-columnCount">0 columns</span> •
            <span id="xv-fileSize">0 KB</span>
        </div>
    </div>
    <div class="xv-controls">
        <div class="xv-sheet-selector-container">
            <label for="xv-sheetSelect" class="xv-sheet-label">Sheet:</label>
            <select id="xv-sheetSelect" class="xv-sheet-select"></select>
        </div>
        <div class="xv-search-container">
            <input type="text" id="xv-searchInput" placeholder="Search in table..." class="xv-search-input" />
            <button id="xv-clearSearch" type="button" class="xv-btn">Clear</button>
        </div>
        <div class="xv-export-container">
            <button id="xv-copyTsv" type="button" class="xv-btn" title="Copy filtered rows as TSV">📋 Copy to Clipboard</button>
            <button id="xv-copyJson" type="button" class="xv-btn" title="Copy filtered rows as JSON">📄 Copy JSON</button>
            <button id="xv-toggleView" type="button" class="xv-btn" title="Toggle between table and raw JSON view">📊 Toggle View</button>
        </div>
    </div>
    <div id="xv-loading" class="xv-loading">Loading Excel file...</div>
    <div id="xv-error" class="xv-error" style="display: none;"></div>
    <div id="xv-tableContainer" class="xv-table-container" style="display: none;">
        <div id="xv-tableWrapper" class="xv-table-wrapper">
            <table id="xv-excelTable" class="xv-table">
                <thead id="xv-tableHeader"></thead>
                <tbody id="xv-tableBody"></tbody>
            </table>
        </div>
        <div id="xv-rawWrapper" class="xv-raw-data-wrapper" style="display: none;">
            <pre id="xv-rawData" class="xv-raw-data"></pre>
        </div>
    </div>
    <div id="xv-pagination" class="xv-pagination" style="display: none;">
        <button id="xv-prevPage" type="button" class="xv-btn">← Previous</button>
        <span id="xv-pageInfo" class="xv-page-info">Page 1 of 1</span>
        <button id="xv-nextPage" type="button" class="xv-btn">Next →</button>
    </div>
</div>
`;

function resolveDom(container: HTMLElement): ExcelDom {
    const need = <T extends HTMLElement>(id: string): T => {
        const el = container.querySelector<T>(`#${id}`);
        if (!el) throw new Error(`excel viewer: missing DOM node #${id}`);
        return el;
    };
    const title = container.querySelector<HTMLElement>('[data-xv-title]');
    if (!title) throw new Error('excel viewer: missing title slot');
    return {
        title,
        sheetInfo: need('xv-sheetInfo'),
        rowCount: need('xv-rowCount'),
        columnCount: need('xv-columnCount'),
        fileSize: need('xv-fileSize'),
        sheetSelect: need<HTMLSelectElement>('xv-sheetSelect'),
        searchInput: need<HTMLInputElement>('xv-searchInput'),
        clearSearchBtn: need<HTMLButtonElement>('xv-clearSearch'),
        copyTsvBtn: need<HTMLButtonElement>('xv-copyTsv'),
        copyJsonBtn: need<HTMLButtonElement>('xv-copyJson'),
        toggleViewBtn: need<HTMLButtonElement>('xv-toggleView'),
        loading: need('xv-loading'),
        error: need('xv-error'),
        tableContainer: need('xv-tableContainer'),
        tableWrapper: need('xv-tableWrapper'),
        tableHeader: need('xv-tableHeader'),
        tableBody: need('xv-tableBody'),
        rawWrapper: need('xv-rawWrapper'),
        rawData: need('xv-rawData'),
        pagination: need('xv-pagination'),
        prevPageBtn: need<HTMLButtonElement>('xv-prevPage'),
        nextPageBtn: need<HTMLButtonElement>('xv-nextPage'),
        pageInfo: need('xv-pageInfo')
    };
}

function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let i = 0;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    const fixed = i === 0 ? size.toFixed(0) : size.toFixed(1);
    return `${fixed} ${units[i]}`;
}

interface SheetCacheEntry {
    sheet: ParsedSheet;
    /** Raw rows (pre-filter) — for repeated searches without re-parse. */
    rawRows: Row[];
    /** Result of last filter+sort applied. */
    filtered: Row[];
}

export function mountExcelViewer(file: File, container: HTMLElement): ExcelViewerHandle {
    ensureStylesInjected();
    container.innerHTML = VIEWER_HTML;

    const dom = resolveDom(container);
    dom.title.textContent = file.name;
    dom.fileSize.textContent = formatFileSize(file.size);

    let workbook: ParsedWorkbook | undefined;
    const sheetCache = new Map<number, SheetCacheEntry>();
    let currentSheetIndex = 0;
    let searchTerm = '';
    let pagination: PaginationState = {
        page: 1,
        rowsPerPage: DEFAULT_ROWS_PER_PAGE,
        totalRows: 0
    };
    let disposed = false;
    // --- raw / table toggle state (#38) -----------------------------------
    // We track scroll-top per view so flipping back-and-forth feels stable
    // even with very long sheets. `null` means "no scroll has been recorded
    // yet" — we fall back to top of the newly-visible host on first flip.
    let viewMode: ExcelViewMode = 'table';
    let savedTableScrollTop: number | null = null;
    let savedRawScrollTop: number | null = null;
    // The raw <pre> is rendered lazily on first flip into raw mode; we cache
    // by sheet index so re-flipping the same sheet doesn't re-stringify the
    // (potentially large) workbook.
    const rawTextCache = new Map<number, string>();

    function getCacheEntry(index: number): SheetCacheEntry | undefined {
        if (!workbook) return undefined;
        const sheet = workbook.sheets[index];
        if (!sheet) return undefined;
        let entry = sheetCache.get(index);
        if (!entry) {
            entry = { sheet, rawRows: sheet.rows.slice(), filtered: sheet.rows.slice() };
            sheetCache.set(index, entry);
        }
        return entry;
    }

    function renderHeader(sheet: ParsedSheet): void {
        dom.tableHeader.innerHTML = '';
        const tr = document.createElement('tr');
        const headers = sheet.headers.length
            ? sheet.headers
            : Array.from({ length: sheet.totalColumns }, (_, i) => `Column ${i + 1}`);
        headers.forEach((header) => {
            const th = document.createElement('th');
            th.textContent = header || '';
            th.title = header || '';
            tr.appendChild(th);
        });
        dom.tableHeader.appendChild(tr);
    }

    function renderRows(rows: Row[]): void {
        dom.tableBody.innerHTML = '';
        const slice = getPageSlice(rows, pagination);
        slice.rows.forEach((row) => {
            const tr = document.createElement('tr');
            (row || []).forEach((cell) => {
                const td = document.createElement('td');
                const text = stringifyCell(cell);
                td.textContent = text;
                td.title = text;
                tr.appendChild(td);
            });
            if (searchTerm && rowMatchesSearch(row, searchTerm)) {
                tr.classList.add('is-search-hit');
            }
            dom.tableBody.appendChild(tr);
        });
        renderPagination(rows.length);
    }

    function renderPagination(totalRows: number): void {
        const totalPages = totalPageCount({ ...pagination, totalRows });
        dom.pageInfo.textContent = `Page ${pagination.page} of ${totalPages}`;
        dom.prevPageBtn.disabled = pagination.page <= 1;
        dom.nextPageBtn.disabled = pagination.page >= totalPages;
        dom.pagination.style.display = totalRows > 0 ? 'flex' : 'none';
    }

    function refresh(): void {
        const entry = getCacheEntry(currentSheetIndex);
        if (!entry) return;
        renderHeader(entry.sheet);
        const filtered = filterRows(entry.rawRows, searchTerm);
        entry.filtered = filtered;
        pagination = { ...pagination, totalRows: filtered.length };
        renderRows(filtered);
        updateFileInfo(entry.sheet);
    }

    function updateFileInfo(sheet: ParsedSheet): void {
        dom.sheetInfo.textContent = sheet.name;
        const filtered = sheetCache.get(currentSheetIndex)?.filtered ?? sheet.rows;
        dom.rowCount.textContent = `${filtered.length.toLocaleString()} rows`;
        dom.columnCount.textContent = `${sheet.totalColumns} columns`;
    }

    function populateSheetSelect(wb: ParsedWorkbook): void {
        dom.sheetSelect.innerHTML = '';
        wb.sheetNames.forEach((name, index) => {
            const opt = document.createElement('option');
            opt.value = String(index);
            opt.textContent = name;
            dom.sheetSelect.appendChild(opt);
        });
    }

    // --- raw / table toggle (#38) -----------------------------------------
    function ensureRawRendered(entry: SheetCacheEntry): void {
        const cached = rawTextCache.get(currentSheetIndex);
        if (cached !== undefined) {
            // Cheap O(1) — only update the DOM if the textContent doesn't
            // already match what we have (it normally will, but the table
            // path doesn't touch <pre> so this is just a guard).
            if (dom.rawData.textContent !== cached) {
                dom.rawData.textContent = cached;
            }
            return;
        }
        const text = renderSheetAsRawJson(entry.sheet);
        rawTextCache.set(currentSheetIndex, text);
        dom.rawData.textContent = text;
    }

    function applySearchInputDisabledState(): void {
        // DoD: "Raw mode disables search". We disable both the input and the
        // Clear button so the search pipeline is fully gated. ESC focus
        // behavior from earlier issues lives outside this module — disabling
        // the input still allows it to be focused via JS, just not edited,
        // so the keyboard escape path stays intact.
        const isRaw = viewMode === 'raw';
        dom.searchInput.disabled = isRaw;
        dom.clearSearchBtn.disabled = isRaw;
        if (isRaw) {
            dom.searchInput.setAttribute('aria-disabled', 'true');
        } else {
            dom.searchInput.removeAttribute('aria-disabled');
        }
    }

    function setView(nextMode: ExcelViewMode): void {
        if (nextMode === viewMode) return;
        // Save the scroll-top of the host that's about to be hidden so we
        // can restore it next time the user flips back.
        if (viewMode === 'table') {
            savedTableScrollTop = dom.tableWrapper.scrollTop;
        } else {
            savedRawScrollTop = dom.rawWrapper.scrollTop;
        }

        viewMode = nextMode;

        if (viewMode === 'raw') {
            const entry = getCacheEntry(currentSheetIndex);
            if (entry) ensureRawRendered(entry);
            dom.tableWrapper.style.display = 'none';
            dom.rawWrapper.style.display = 'block';
            // Pagination is meaningless in raw view — the whole sheet is in
            // the <pre>. Hide the footer to avoid implying otherwise.
            dom.pagination.style.display = 'none';
            dom.rawWrapper.scrollTop = savedRawScrollTop ?? 0;
            dom.toggleViewBtn.textContent = 'Table View';
            dom.toggleViewBtn.title = 'Switch back to the paginated table view';
        } else {
            dom.rawWrapper.style.display = 'none';
            dom.tableWrapper.style.display = 'block';
            // Re-render pagination footer based on the *current* filtered set
            // (a re-flip should not desync the page number).
            const entry = getCacheEntry(currentSheetIndex);
            const totalRows = entry ? entry.filtered.length : 0;
            renderPagination(totalRows);
            dom.tableWrapper.scrollTop = savedTableScrollTop ?? 0;
            dom.toggleViewBtn.textContent = 'Raw View';
            dom.toggleViewBtn.title = 'Toggle between table and raw JSON view';
        }
        applySearchInputDisabledState();
    }

    const onToggleView = (): void => {
        setView(toggleViewMode(viewMode));
    };

    // --- listeners --------------------------------------------------------
    const onSheetChange = (e: Event): void => {
        const next = parseInt((e.target as HTMLSelectElement).value, 10);
        if (Number.isNaN(next)) return;
        currentSheetIndex = next;
        searchTerm = '';
        dom.searchInput.value = '';
        pagination = { ...pagination, page: 1 };
        // Switching sheets invalidates the per-sheet scroll memory and the
        // cached raw payload for this slot will be re-resolved on next flip.
        savedTableScrollTop = null;
        savedRawScrollTop = null;
        refresh();
        if (viewMode === 'raw') {
            const entry = getCacheEntry(currentSheetIndex);
            if (entry) ensureRawRendered(entry);
        }
    };

    const onSearchInput = (e: Event): void => {
        const value = (e.target as HTMLInputElement).value;
        searchTerm = value;
        const entry = getCacheEntry(currentSheetIndex);
        if (!entry) return;
        const result = applySearch(entry.rawRows, searchTerm, pagination.rowsPerPage);
        entry.filtered = result.filtered;
        pagination = result.pagination;
        renderRows(result.filtered);
        updateFileInfo(entry.sheet);
    };

    const onClearSearch = (): void => {
        if (!dom.searchInput.value && !searchTerm) return;
        dom.searchInput.value = '';
        searchTerm = '';
        const entry = getCacheEntry(currentSheetIndex);
        if (!entry) return;
        const result = applySearch(entry.rawRows, '', pagination.rowsPerPage);
        entry.filtered = result.filtered;
        pagination = result.pagination;
        renderRows(result.filtered);
        updateFileInfo(entry.sheet);
    };

    const onPrev = (): void => {
        pagination = prevPage(pagination);
        const entry = getCacheEntry(currentSheetIndex);
        if (entry) renderRows(entry.filtered);
    };

    const onNext = (): void => {
        pagination = nextPage(pagination);
        const entry = getCacheEntry(currentSheetIndex);
        if (entry) renderRows(entry.filtered);
    };

    // --- copy / export (#37) -------------------------------------------
    // Both handlers pull from the cached *filtered* rows so search +
    // pagination state is honored (DoD: "only visible filtered rows").
    // We export the entire filtered set, not just the current page —
    // users typically want all matches, not just what fits on screen.
    function getHeadersForExport(entry: SheetCacheEntry): string[] {
        if (entry.sheet.headers.length > 0) return entry.sheet.headers;
        return Array.from({ length: entry.sheet.totalColumns }, (_, i) => `Column ${i + 1}`);
    }

    function flashButton(btn: HTMLButtonElement, label: string, ms = 1200): void {
        const original = btn.dataset.originalLabel ?? btn.textContent ?? '';
        if (!btn.dataset.originalLabel) btn.dataset.originalLabel = original;
        btn.textContent = label;
        btn.classList.add('is-flashing');
        const timeoutId = window.setTimeout(() => {
            btn.textContent = btn.dataset.originalLabel ?? original;
            btn.classList.remove('is-flashing');
        }, ms);
        // Stash the timeout id so a rapid second click overwrites it cleanly.
        const prev = Number(btn.dataset.flashTimeoutId);
        if (prev) window.clearTimeout(prev);
        btn.dataset.flashTimeoutId = String(timeoutId);
    }

    async function writeToClipboard(text: string): Promise<boolean> {
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch {
            // fall through to legacy path below
        }
        // Legacy fallback for non-secure contexts / older browsers.
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(textarea);
            return ok;
        } catch {
            return false;
        }
    }

    const onCopyTsv = async (): Promise<void> => {
        const entry = getCacheEntry(currentSheetIndex);
        if (!entry) return;
        const headers = getHeadersForExport(entry);
        const tsv = serializeRowsAsTsv(headers, entry.filtered);
        const ok = await writeToClipboard(tsv);
        flashButton(dom.copyTsvBtn, ok ? 'Copied!' : 'Copy failed');
    };

    const onCopyJson = async (): Promise<void> => {
        const entry = getCacheEntry(currentSheetIndex);
        if (!entry) return;
        const headers = getHeadersForExport(entry);
        const payload = serializeRowsAsJson(headers, entry.filtered);
        const json = JSON.stringify(payload, null, 2);
        const ok = await writeToClipboard(json);
        flashButton(dom.copyJsonBtn, ok ? 'Copied!' : 'Copy failed');
    };

    dom.sheetSelect.addEventListener('change', onSheetChange);
    dom.searchInput.addEventListener('input', onSearchInput);
    dom.clearSearchBtn.addEventListener('click', onClearSearch);
    dom.copyTsvBtn.addEventListener('click', onCopyTsv);
    dom.copyJsonBtn.addEventListener('click', onCopyJson);
    dom.toggleViewBtn.addEventListener('click', onToggleView);
    dom.prevPageBtn.addEventListener('click', onPrev);
    dom.nextPageBtn.addEventListener('click', onNext);

    // Initial label / disabled state ("table" view is the default).
    dom.toggleViewBtn.textContent = 'Raw View';
    applySearchInputDisabledState();

    // --- async load -------------------------------------------------------
    void (async () => {
        try {
            const wb = await parseWorkbookFromFile(file);
            if (disposed) return;
            workbook = wb;
            populateSheetSelect(wb);
            currentSheetIndex = 0;
            dom.loading.style.display = 'none';
            dom.tableContainer.style.display = 'block';
            // Default into table view; raw view stays hidden until the user
            // hits "Toggle View".
            dom.tableWrapper.style.display = 'block';
            dom.rawWrapper.style.display = 'none';
            refresh();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            dom.loading.style.display = 'none';
            dom.error.style.display = 'block';
            dom.error.textContent = `Failed to load Excel file: ${message}`;
        }
    })();

    return {
        dispose(): void {
            disposed = true;
            dom.sheetSelect.removeEventListener('change', onSheetChange);
            dom.searchInput.removeEventListener('input', onSearchInput);
            dom.clearSearchBtn.removeEventListener('click', onClearSearch);
            dom.copyTsvBtn.removeEventListener('click', onCopyTsv);
            dom.copyJsonBtn.removeEventListener('click', onCopyJson);
            dom.toggleViewBtn.removeEventListener('click', onToggleView);
            dom.prevPageBtn.removeEventListener('click', onPrev);
            dom.nextPageBtn.removeEventListener('click', onNext);
            sheetCache.clear();
            rawTextCache.clear();
        }
    };
}
