// CSV viewer entry (issue #33).
//
// This is the Chrome-side port of the VSCode `csvViewer.js`, scoped down to
// the **minimum needed for column sort** to land cleanly:
//
//   - Parse a CSV file via the small parser in ./csvParser.
//   - Render headers + rows into a `<table id="csvTable">` shell.
//   - Wire per-column sort buttons (asc -> desc -> none cycle) backed by the
//     pure helpers in ./csvSort. Type detection is numeric / date / text.
//
// Now wired up:
//   - Delimiter auto-detection + manual override (#34, ./csvDelimiter)
//   - Column statistics panel + Ctrl+F / Ctrl+C shortcuts (#35,
//     ./csvStatistics) — Ctrl+C copies the *filtered* rows as TSV.
//
// Also includes VS Code parity controls: pagination, raw/table switching,
// TSV copy, and JSON copy.
//
// The module intentionally exposes a `mountCsvViewer(file, container)` factory
// so it can be reused by `viewerRegistry.ts` (the router calls
// `provider.render(file, container)`), and as a side-effect it self-mounts on
// `DOMContentLoaded` when loaded by the standalone per-viewer page
// (`templates/csv/csvViewer.html`).

import { applyDocumentLocale, t } from '../../../utils/i18n';
import { parseCsv, ParsedCsv } from './csvParser';
import {
    applySort,
    detectColumnType,
    nextSortState,
    SortDirection,
    SortState
} from './csvSort';
import {
    CsvDelimiter,
    detectDelimiterForFile
} from './csvDelimiter';
import {
    ColumnStats,
    computeStatistics,
    formatPercent,
    formatStatNumber,
    serializeRowsToTsv
} from './csvStatistics';

export interface CsvViewerHandle {
    dispose(): void;
}

interface ViewState {
    parsed: ParsedCsv;
    /** Indices into parsed.rows in current display order. */
    rowIndices: number[];
    sort: SortState;
    /** Raw text so we can re-parse on manual delimiter override. */
    rawText: string;
    /** Currently active delimiter (auto-detected or user-selected). */
    delimiter: CsvDelimiter;
    /** Active substring filter (case-insensitive). Empty = no filter. */
    search: string;
    /** Whether the statistics panel is currently visible. */
    statsVisible: boolean;
    page: number;
    pageSize: number;
    rawVisible: boolean;
}

const DELIMITER_OPTIONS: ReadonlyArray<{ value: CsvDelimiter; label: string }> = [
    { value: ',', label: 'Comma  (,)' },
    { value: '\t', label: 'Tab  (\\t)' },
    { value: ';', label: 'Semicolon  (;)' },
    { value: '|', label: 'Pipe  (|)' }
];

const SORT_ICON_HTML =
    '<span class="sort-icon sort-icon-asc" aria-hidden="true">▲</span>' +
    '<span class="sort-icon sort-icon-desc" aria-hidden="true">▼</span>';

/**
 * Public entry. Reads the file, parses it, and renders into `container`.
 * Returns a handle whose `dispose()` clears the container.
 */
export async function mountCsvViewer(
    file: File,
    container: HTMLElement
): Promise<CsvViewerHandle> {
    applyDocumentLocale();
    container.innerHTML = '';
    container.classList.add('csv-viewer-host');

    const root = buildShell(container, file.name);
    showLoading(root, true);

    let detachShortcuts: (() => void) | null = null;

    try {
        const text = await file.text();
        const detection = detectDelimiterForFile(file.name, text);
        const delimiter: CsvDelimiter = detection.delimiter;
        const parsed = parseCsv(text, { delimiter });
        const state: ViewState = {
            parsed,
            rowIndices: parsed.rows.map((_, i) => i),
            sort: { columnIndex: null, direction: null },
            rawText: text,
            delimiter,
            search: '',
            statsVisible: false,
            page: 1,
            pageSize: 200,
            rawVisible: false
        };

        if (root.delimiterSelect) {
            root.delimiterSelect.value = delimiter;
            root.delimiterSelect.disabled = false;
            root.delimiterSelect.addEventListener('change', () => {
                const next = root.delimiterSelect!.value as CsvDelimiter;
                if (next === state.delimiter) return;
                state.delimiter = next;
                state.parsed = parseCsv(state.rawText, { delimiter: next });
                state.search = '';
                state.page = 1;
                if (root.searchInput) root.searchInput.value = '';
                recomputeRowOrder(state);
                state.sort = { columnIndex: null, direction: null };
                renderHeader(root, state, () => renderBody(root, state));
                renderBody(root, state);
                updateFileInfo(root, state.parsed, file);
                if (state.statsVisible) renderStatsPanel(root, state);
            });
        }

        if (root.searchInput) {
            root.searchInput.addEventListener('input', () => {
                state.search = root.searchInput!.value;
                state.page = 1;
                recomputeRowOrder(state);
                renderBody(root, state);
            });
        }

        if (root.statsToggle) {
            root.statsToggle.addEventListener('click', () => {
                state.statsVisible = !state.statsVisible;
                root.statsToggle!.setAttribute(
                    'aria-pressed',
                    state.statsVisible ? 'true' : 'false'
                );
                root.statsToggle!.textContent = state.statsVisible
                    ? t('csvHideStatistics', 'Hide Statistics')
                    : t('csvShowStatistics', 'Show Statistics');
                if (state.statsVisible) {
                    renderStatsPanel(root, state);
                    root.statsPanel.style.display = 'block';
                } else {
                    root.statsPanel.style.display = 'none';
                }
            });
        }

        root.copyTsvButton.addEventListener('click', () => { void copyFilteredRowsAsTsv(state); });
        root.copyJsonButton.addEventListener('click', () => {
            const rows = state.rowIndices.map((index) => rowAsObject(state.parsed, index));
            void navigator.clipboard?.writeText(JSON.stringify(rows, null, 2));
        });
        root.toggleViewButton.addEventListener('click', () => {
            state.rawVisible = !state.rawVisible;
            root.rawPane.style.display = state.rawVisible ? 'block' : 'none';
            root.tableContainer.style.display = state.rawVisible ? 'none' : 'block';
            root.toggleViewButton.textContent = state.rawVisible ? 'Table View' : 'Raw View';
        });
        root.prevPageButton.addEventListener('click', () => { state.page = Math.max(1, state.page - 1); renderBody(root, state); });
        root.nextPageButton.addEventListener('click', () => { state.page += 1; renderBody(root, state); });
        root.rawPane.textContent = rawText;

        detachShortcuts = installKeyboardShortcuts(root, state);

        renderHeader(root, state, () => renderBody(root, state));
        renderBody(root, state);
        updateFileInfo(root, parsed, file);
        showLoading(root, false);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showError(root, t('csvLoadFailed', `Failed to load CSV: ${message}`, message));
    }

    return {
        dispose() {
            if (detachShortcuts) detachShortcuts();
            container.innerHTML = '';
            container.classList.remove('csv-viewer-host');
        }
    };
}

interface ShellRefs {
    /** The viewer-mounted root element (where keyboard listeners attach). */
    root: HTMLElement;
    title: HTMLElement;
    rowCount: HTMLElement;
    columnCount: HTMLElement;
    fileSize: HTMLElement;
    table: HTMLTableElement;
    thead: HTMLTableSectionElement;
    tbody: HTMLTableSectionElement;
    loading: HTMLElement;
    error: HTMLElement;
    tableWrapper: HTMLElement;
    delimiterSelect: HTMLSelectElement | null;
    searchInput: HTMLInputElement | null;
    statsToggle: HTMLButtonElement | null;
    statsPanel: HTMLElement;
    copyTsvButton: HTMLButtonElement;
    copyJsonButton: HTMLButtonElement;
    toggleViewButton: HTMLButtonElement;
    tableContainer: HTMLElement;
    rawPane: HTMLPreElement;
    prevPageButton: HTMLButtonElement;
    nextPageButton: HTMLButtonElement;
    pageInfo: HTMLElement;
}

function buildShell(container: HTMLElement, fileName: string): ShellRefs {
    const wrap = document.createElement('div');
    wrap.className = 'csv-container';

    const header = document.createElement('div');
    header.className = 'csv-header';

    const title = document.createElement('div');
    title.className = 'csv-title';
    title.textContent = `📊 ${fileName}`;

    const fileInfo = document.createElement('div');
    fileInfo.className = 'csv-file-info';

    const rowCount = document.createElement('span');
    rowCount.className = 'csv-row-count';
    rowCount.textContent = '0 rows';

    const columnCount = document.createElement('span');
    columnCount.className = 'csv-column-count';
    columnCount.textContent = '0 columns';

    const fileSize = document.createElement('span');
    fileSize.className = 'csv-file-size';
    fileSize.textContent = '0 KB';

    fileInfo.append(rowCount, sep(), columnCount, sep(), fileSize);
    header.append(title, fileInfo);

    // Toolbar: currently hosts the delimiter override <select> (#34). Search
    // and statistics will be appended here by follow-up issues.
    const toolbar = document.createElement('div');
    toolbar.className = 'csv-toolbar';

    const delimiterLabel = document.createElement('label');
    delimiterLabel.className = 'csv-delimiter-label';
    delimiterLabel.htmlFor = 'delimiterSelect';
    delimiterLabel.textContent = t('csvDelimiterLabel', 'Delimiter:');

    const delimiterSelect = document.createElement('select');
    delimiterSelect.id = 'delimiterSelect';
    delimiterSelect.className = 'csv-delimiter-select';
    // Disabled until parsing finishes; the entry re-enables and wires the
    // change listener once it has the raw text + state.
    delimiterSelect.disabled = true;
    for (const opt of DELIMITER_OPTIONS) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        delimiterSelect.appendChild(option);
    }

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.id = 'csvSearchInput';
    searchInput.className = 'csv-search-input';
    searchInput.placeholder = t('csvSearchPlaceholder', 'Search rows…');
    searchInput.setAttribute('aria-label', t('csvSearchPlaceholder', 'Search rows…'));

    const statsToggle = document.createElement('button');
    statsToggle.type = 'button';
    statsToggle.className = 'csv-stats-toggle';
    statsToggle.textContent = t('csvShowStatistics', 'Show Statistics');
    statsToggle.setAttribute('aria-pressed', 'false');

    const copyTsvButton = document.createElement('button');
    copyTsvButton.type = 'button'; copyTsvButton.className = 'csv-stats-toggle'; copyTsvButton.textContent = '📋 Copy to Clipboard';
    const copyJsonButton = document.createElement('button');
    copyJsonButton.type = 'button'; copyJsonButton.className = 'csv-stats-toggle'; copyJsonButton.textContent = '📄 Copy JSON';
    const toggleViewButton = document.createElement('button');
    toggleViewButton.type = 'button'; toggleViewButton.className = 'csv-stats-toggle'; toggleViewButton.textContent = '📊 Toggle View';

    const clearSearch = document.createElement('button'); clearSearch.type = 'button'; clearSearch.className = 'csv-stats-toggle'; clearSearch.textContent = 'Clear'; clearSearch.addEventListener('click', () => { searchInput.value = ''; searchInput.dispatchEvent(new Event('input')); });
    const searchControls = document.createElement('div'); searchControls.className = 'csv-search-controls'; searchControls.append(searchInput, clearSearch);
    const viewControls = document.createElement('div'); viewControls.className = 'csv-view-controls'; viewControls.append(copyTsvButton, copyJsonButton, toggleViewButton);
    toolbar.append(searchControls, viewControls);
    const secondaryToolbar = document.createElement('div'); secondaryToolbar.className = 'csv-secondary-toolbar'; secondaryToolbar.append(delimiterLabel, delimiterSelect, statsToggle);

    const statsPanel = document.createElement('div');
    statsPanel.className = 'csv-stats-panel';
    statsPanel.style.display = 'none';
    statsPanel.setAttribute('role', 'region');
    statsPanel.setAttribute('aria-label', 'Column statistics');

    const tableContainer = document.createElement('div');
    tableContainer.className = 'csv-table-container';

    const loading = document.createElement('div');
    loading.className = 'csv-loading';
    loading.textContent = t('csvLoading', 'Loading CSV…');

    const error = document.createElement('div');
    error.className = 'csv-error';
    error.style.display = 'none';

    const tableWrapper = document.createElement('div');
    tableWrapper.className = 'csv-table-wrapper';
    tableWrapper.style.display = 'none';

    const table = document.createElement('table');
    table.className = 'csv-table';
    table.id = 'csvTable';
    const thead = document.createElement('thead');
    thead.id = 'tableHeader';
    const tbody = document.createElement('tbody');
    tbody.id = 'tableBody';
    table.append(thead, tbody);
    tableWrapper.appendChild(table);

    const rawPane = document.createElement('pre');
    rawPane.className = 'csv-raw-pane'; rawPane.style.display = 'none';

    const pagination = document.createElement('div'); pagination.className = 'csv-pagination';
    const prevPageButton = document.createElement('button'); prevPageButton.type = 'button'; prevPageButton.className = 'csv-stats-toggle'; prevPageButton.textContent = '← Previous';
    const pageInfo = document.createElement('span'); pageInfo.className = 'csv-page-info';
    const nextPageButton = document.createElement('button'); nextPageButton.type = 'button'; nextPageButton.className = 'csv-stats-toggle'; nextPageButton.textContent = 'Next →';
    pagination.append(prevPageButton, pageInfo, nextPageButton);

    tableContainer.append(loading, error, tableWrapper, pagination);
    wrap.append(header, toolbar, secondaryToolbar, statsPanel, tableContainer, rawPane);
    container.appendChild(wrap);

    return {
        root: wrap,
        title,
        rowCount,
        columnCount,
        fileSize,
        table,
        thead,
        tbody,
        loading,
        error,
        tableWrapper,
        delimiterSelect,
        searchInput,
        statsToggle,
        statsPanel,
        copyTsvButton, copyJsonButton, toggleViewButton, tableContainer, rawPane,
        prevPageButton, nextPageButton, pageInfo
    };
}

function sep(): HTMLSpanElement {
    const s = document.createElement('span');
    s.textContent = ' • ';
    s.className = 'csv-sep';
    return s;
}

function showLoading(refs: ShellRefs, on: boolean): void {
    refs.loading.style.display = on ? 'flex' : 'none';
    refs.tableWrapper.style.display = on ? 'none' : 'block';
}

function showError(refs: ShellRefs, message: string): void {
    refs.loading.style.display = 'none';
    refs.tableWrapper.style.display = 'none';
    refs.error.style.display = 'flex';
    refs.error.textContent = message;
}

function updateFileInfo(refs: ShellRefs, parsed: ParsedCsv, file: File): void {
    refs.rowCount.textContent = `${parsed.rows.length} rows`;
    refs.columnCount.textContent = `${parsed.columnCount} columns`;
    refs.fileSize.textContent = formatBytes(file.size);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Render the `<thead>` row. Each header gets a sort button that cycles state
 * via `nextSortState` and triggers `onSortChange` to re-render the body.
 */
function renderHeader(
    refs: ShellRefs,
    state: ViewState,
    onSortChange: () => void
): void {
    refs.thead.innerHTML = '';
    const tr = document.createElement('tr');

    state.parsed.headers.forEach((header, index) => {
        const th = document.createElement('th');
        th.setAttribute('data-col', String(index));
        th.className = 'csv-th';

        const content = document.createElement('div');
        content.className = 'header-content';

        const label = document.createElement('span');
        label.className = 'header-label';
        label.textContent = header;
        label.title = header;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sort-button';
        const dir = currentDirectionFor(state.sort, index);
        button.setAttribute('data-sort-direction', dir ?? 'none');
        button.setAttribute(
            'aria-label',
            `Sort by ${header || `column ${index + 1}`}`
        );
        button.title = sortButtonTitle(dir, header || `column ${index + 1}`);
        button.innerHTML = SORT_ICON_HTML;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            state.sort = nextSortState(state.sort, index);
            recomputeRowOrder(state);
            renderHeader(refs, state, onSortChange);
            onSortChange();
        });

        // Allow clicking the th itself (not just the icon) for usability.
        th.addEventListener('click', () => {
            state.sort = nextSortState(state.sort, index);
            recomputeRowOrder(state);
            renderHeader(refs, state, onSortChange);
            onSortChange();
        });

        content.append(label, button);
        th.appendChild(content);
        tr.appendChild(th);
    });

    refs.thead.appendChild(tr);
}

function currentDirectionFor(
    sort: SortState,
    columnIndex: number
): SortDirection {
    return sort.columnIndex === columnIndex ? sort.direction : null;
}

function sortButtonTitle(dir: SortDirection, label: string): string {
    if (dir === 'asc') {
        return `Sorted ascending. Click to sort ${label} descending.`;
    }
    if (dir === 'desc') {
        return `Sorted descending. Click to clear sorting for ${label}.`;
    }
    return `Click to sort ${label} ascending.`;
}

function recomputeRowOrder(state: ViewState): void {
    const allIndices = state.parsed.rows.map((_, i) => i);
    const filtered = filterRowIndices(state, allIndices);
    state.rowIndices = applySort(
        filtered,
        state.sort,
        (rowIndex, colIndex) => state.parsed.rows[rowIndex]?.[colIndex] ?? ''
    );
}

function filterRowIndices(
    state: ViewState,
    indices: readonly number[]
): number[] {
    const q = state.search.trim().toLowerCase();
    if (!q) return [...indices];
    const out: number[] = [];
    for (const i of indices) {
        const row = state.parsed.rows[i];
        if (!row) continue;
        for (const cell of row) {
            if (cell && cell.toLowerCase().includes(q)) {
                out.push(i);
                break;
            }
        }
    }
    return out;
}

function renderBody(refs: ShellRefs, state: ViewState): void {
    refs.tbody.innerHTML = '';
    const totalPages = Math.max(1, Math.ceil(state.rowIndices.length / state.pageSize));
    state.page = Math.min(totalPages, Math.max(1, state.page));
    const start = (state.page - 1) * state.pageSize;
    for (const rowIndex of state.rowIndices.slice(start, start + state.pageSize)) {
        const row = state.parsed.rows[rowIndex];
        const tr = document.createElement('tr');
        for (let c = 0; c < state.parsed.columnCount; c++) {
            const td = document.createElement('td');
            const cell = row[c] ?? '';
            td.textContent = cell;
            td.title = cell;
            tr.appendChild(td);
        }
        refs.tbody.appendChild(tr);
    }
    refs.pageInfo.textContent = `Page ${state.page} of ${totalPages}`;
    refs.prevPageButton.disabled = state.page <= 1;
    refs.nextPageButton.disabled = state.page >= totalPages;
}

function rowAsObject(parsed: ParsedCsv, rowIndex: number): Record<string, string> {
    const row = parsed.rows[rowIndex] ?? [];
    return Object.fromEntries(parsed.headers.map((header, index) => [header || `column_${index + 1}`, row[index] ?? '']));
}

/**
 * Render the statistics panel for the *currently parsed* dataset (full rows,
 * not the search-filtered view) so the numbers match the file rather than
 * jumping around as the user types.
 */
function renderStatsPanel(refs: ShellRefs, state: ViewState): void {
    const stats = computeStatistics(state.parsed.rows, state.parsed.headers);
    refs.statsPanel.innerHTML = '';

    const summary = document.createElement('div');
    summary.className = 'csv-stats-summary';
    summary.textContent =
        `${state.parsed.rows.length} rows · ${state.parsed.columnCount} columns`;
    refs.statsPanel.appendChild(summary);

    const table = document.createElement('table');
    table.className = 'csv-stats-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Column', 'Null %', 'Mean', 'Min', 'Max']) {
        const th = document.createElement('th');
        th.textContent = label;
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const s of stats) {
        tbody.appendChild(renderStatsRow(s));
    }
    table.appendChild(tbody);
    refs.statsPanel.appendChild(table);
}

function renderStatsRow(s: ColumnStats): HTMLTableRowElement {
    const tr = document.createElement('tr');

    const tdHeader = document.createElement('td');
    tdHeader.className = 'csv-stats-col';
    tdHeader.textContent = s.header || `Column ${s.columnIndex + 1}`;
    tr.appendChild(tdHeader);

    const tdNull = document.createElement('td');
    tdNull.textContent = formatPercent(s.nullPercent);
    tdNull.title = `${s.nullCount} / ${s.total} null`;
    tr.appendChild(tdNull);

    const numericCells: Array<string> = s.numeric
        ? [
              formatStatNumber(s.numeric.mean),
              formatStatNumber(s.numeric.min),
              formatStatNumber(s.numeric.max)
          ]
        : ['—', '—', '—'];
    for (const v of numericCells) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
    }

    return tr;
}

/**
 * Wire up Ctrl/Cmd+F (focus search) and Ctrl/Cmd+C (copy filtered rows as
 * TSV when nothing is selected).
 *
 * Guardrails:
 *   - When the focused element is itself an `<input>`, `<textarea>`, or
 *     `[contenteditable]`, we hand the keystroke back to the browser so the
 *     user's typing experience (e.g. select-all-in-input + copy) is intact.
 *   - When the user has a real text selection on the page, we do nothing —
 *     the browser-default copy of the selection wins.
 *   - Returns a detach function so the viewer can clean up on dispose.
 */
function installKeyboardShortcuts(
    refs: ShellRefs,
    state: ViewState
): () => void {
    const handler = (event: KeyboardEvent): void => {
        const mod = event.ctrlKey || event.metaKey;
        if (!mod || event.altKey) return;

        const key = event.key.toLowerCase();
        if (key !== 'f' && key !== 'c') return;

        // Only act when the keystroke originates from inside our viewer.
        const target = event.target as Node | null;
        if (target && refs.root && !refs.root.contains(target)) return;

        if (isEditableTarget(event.target)) return;

        if (key === 'f') {
            if (!refs.searchInput) return;
            event.preventDefault();
            refs.searchInput.focus();
            refs.searchInput.select();
            return;
        }

        if (key === 'c') {
            if (hasNonEmptySelection()) return;
            event.preventDefault();
            void copyFilteredRowsAsTsv(state);
        }
    };

    document.addEventListener('keydown', handler);
    return () => {
        document.removeEventListener('keydown', handler);
    };
}

function isEditableTarget(target: EventTarget | null): boolean {
    if (!target || !(target as HTMLElement).tagName) return false;
    const el = target as HTMLElement;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
}

function hasNonEmptySelection(): boolean {
    if (typeof window === 'undefined' || !window.getSelection) return false;
    const sel = window.getSelection();
    if (!sel) return false;
    const text = sel.toString();
    return text != null && text.length > 0;
}

async function copyFilteredRowsAsTsv(state: ViewState): Promise<void> {
    const rows = state.rowIndices.map((i) => state.parsed.rows[i] ?? []);
    const tsv = serializeRowsToTsv(rows, state.parsed.headers);
    try {
        if (
            typeof navigator !== 'undefined' &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === 'function'
        ) {
            await navigator.clipboard.writeText(tsv);
        }
    } catch {
        // Clipboard API may reject if the document isn't focused; we swallow
        // here rather than surfacing a noisy error — the keystroke is still
        // a no-op from the user's perspective and they can retry.
    }
}

// Re-export pure helpers for tests + external consumers (e.g. issue #34/#35
// can import detectColumnType to feed statistics).
export { detectColumnType, applySort, nextSortState };
export type { SortDirection, SortState };

// ---------------------------------------------------------------------------
// Standalone-page bootstrap (mirrors the imageViewer.ts pattern).
// ---------------------------------------------------------------------------
//
// When this bundle is loaded by `templates/csv/csvViewer.html` directly
// (manual debugging via "Load unpacked" + chrome://extensions), there is no
// router to hand us a File. The shell uses the blob-URL handoff stub
// described in `src/router.ts`; we read `?src=` and reconstruct a File.
//
// Production traffic goes through the registry/router — that path imports
// `mountCsvViewer` directly and never triggers self-bootstrap. We also
// expose the helper on `window.__omniMountCsv` so other harnesses can call
// it without re-importing the bundle.

declare global {
    interface Window {
        __omniMountCsv?: typeof mountCsvViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountCsv = mountCsvViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="csv"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="csv"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        // Leave the static skeleton in place when no file is present.
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'data.csv');
        const file = new File([blob], name, { type: blob.type || 'text/csv' });
        await mountCsvViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = t('csvLoadFailed', `Failed to load CSV: ${message}`, message);
    }
}

if (isSelfBootstrap()) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            void selfBootstrap();
        });
    } else {
        void selfBootstrap();
    }
}
