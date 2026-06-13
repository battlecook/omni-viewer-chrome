// Orchestration layer for the Chrome Word viewer (issue #43 — "zoom +
// print" minimum port).
//
// Wires together:
//   - DOM scaffolding (toolbar with zoom controls + print button,
//     scrollable body, document container that docx-preview renders
//     into),
//   - the docx-preview vendor library (`./wordDocxLoader.ts`),
//   - the discrete zoom ladder (`./wordZoom.ts`),
//   - keyboard shortcuts: Ctrl/Cmd + `=` / `-` / `0` for zoom in /
//     out / reset, Ctrl/Cmd + `P` for print.
//
// Scope is locked to issue #43:
//   - render `.docx` via docx-preview (minimum render skeleton),
//   - 10-step zoom from 50% to 250% applied via CSS `transform: scale`,
//   - print via `window.print()` plus a `@media print` block in the
//     runtime CSS that hides toolbar / header.
//
// Out of scope (intentionally left as TODO anchors for follow-up
// issues):
//   - `.doc` legacy fallback via mammoth — issue #44.
//
// Issue #45 adds an "Embedded objects" panel beneath the document for
// workbooks under `word/embeddings/` and charts under `word/charts/`.
// See `wordEmbeddings.ts` + `wordChartSvg.ts`.

import { WORD_VIEWER_CSS } from './wordViewerStyles';
import { loadDocxPreview, loadJsZip, loadXlsxLib } from './wordDocxLoader';
import {
    detectWordFormat,
    looksLikeCfbContainer
} from '../../../utils/fileUtils/word';
import { parseDocToHtml } from '../../../utils/docBinaryParser';
import {
    WORD_DEFAULT_ZOOM_PERCENT,
    WORD_ZOOM_LEVELS_PERCENT,
    canZoomIn,
    canZoomOut,
    formatZoomLabel,
    nextZoom,
    percentToScale,
    prevZoom
} from './wordZoom';
import {
    EmbeddingsManifest,
    extractChartXml,
    extractWorkbookPreview,
    scanEmbeddings,
    WORD_EMBED_PREVIEW_MAX_COLS,
    WORD_EMBED_PREVIEW_MAX_ROWS,
    WorkbookPreview,
    ZipLike
} from './wordEmbeddings';
import { parseChartXml, renderChartSvg } from './wordChartSvg';

const STYLE_ELEMENT_ID = 'omni-viewer-word-styles';

function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = WORD_VIEWER_CSS;
    document.head.appendChild(style);
}

interface WordViewerDom {
    root: HTMLElement;
    title: HTMLElement;
    fileInfo: HTMLElement;
    zoomLevel: HTMLElement;
    zoomInBtn: HTMLButtonElement;
    zoomOutBtn: HTMLButtonElement;
    zoomResetBtn: HTMLButtonElement;
    printBtn: HTMLButtonElement;
    body: HTMLElement;
    docContainer: HTMLElement;
    loading: HTMLElement;
    error: HTMLElement;
    embeddedPanel: HTMLDetailsElement;
    embeddedBody: HTMLElement;
    embeddedCount: HTMLElement;
}

export interface WordViewerHandle {
    dispose(): void;
}

const VIEWER_HTML = /* html */ `
<div class="wv-container" data-word-viewer-root>
    <div class="wv-header">
        <div class="wv-title" data-wv-title></div>
        <div class="wv-file-info" data-wv-file-info></div>
    </div>
    <div class="wv-toolbar">
        <button type="button" id="wv-zoomOut" class="wv-text-btn" title="Zoom out (Ctrl/Cmd + -)">➖ Zoom out</button>
        <span id="wv-zoomLevel" class="wv-zoom-level">100%</span>
        <button type="button" id="wv-zoomIn" class="wv-text-btn" title="Zoom in (Ctrl/Cmd + =)">➕ Zoom in</button>
        <button type="button" id="wv-zoomReset" class="wv-text-btn" title="Reset zoom (Ctrl/Cmd + 0)">🔄 Reset</button>
        <span class="wv-toolbar-spacer"></span>
        <button type="button" id="wv-print" class="wv-text-btn" title="Print (Ctrl/Cmd + P)">🖨️ Print</button>
        <!-- TODO #44 — legacy .doc fallback indicator -->
    </div>
    <div id="wv-loading" class="wv-loading">Loading Word document…</div>
    <div id="wv-error" class="wv-error" style="display: none;"></div>
    <div id="wv-body" class="wv-body" style="display: none;">
        <div id="docContainer" class="wv-doc-container"></div>
        <details id="wv-embedded" class="wv-embedded" style="display: none;">
            <summary class="wv-embedded-summary">
                <span class="wv-embedded-title">Embedded objects</span>
                <span class="wv-embedded-count" data-wv-embedded-count></span>
            </summary>
            <div class="wv-embedded-body" data-wv-embedded-body></div>
        </details>
    </div>
</div>
`;

function resolveDom(container: HTMLElement): WordViewerDom {
    const need = <T extends HTMLElement>(id: string): T => {
        const el = container.querySelector<T>(`#${id}`);
        if (!el) throw new Error(`word viewer: missing DOM node #${id}`);
        return el;
    };
    const root = container.querySelector<HTMLElement>('[data-word-viewer-root]');
    if (!root) throw new Error('word viewer: failed to mount root element');
    const title = root.querySelector<HTMLElement>('[data-wv-title]');
    const fileInfo = root.querySelector<HTMLElement>('[data-wv-file-info]');
    if (!title) throw new Error('word viewer: missing title slot');
    if (!fileInfo) throw new Error('word viewer: missing file-info slot');
    const embeddedBody = root.querySelector<HTMLElement>(
        '[data-wv-embedded-body]'
    );
    const embeddedCount = root.querySelector<HTMLElement>(
        '[data-wv-embedded-count]'
    );
    if (!embeddedBody) throw new Error('word viewer: missing embedded body slot');
    if (!embeddedCount) throw new Error('word viewer: missing embedded count slot');
    return {
        root,
        title,
        fileInfo,
        zoomLevel: need('wv-zoomLevel'),
        zoomInBtn: need<HTMLButtonElement>('wv-zoomIn'),
        zoomOutBtn: need<HTMLButtonElement>('wv-zoomOut'),
        zoomResetBtn: need<HTMLButtonElement>('wv-zoomReset'),
        printBtn: need<HTMLButtonElement>('wv-print'),
        body: need('wv-body'),
        docContainer: need('docContainer'),
        loading: need('wv-loading'),
        error: need('wv-error'),
        embeddedPanel: need<HTMLDetailsElement>('wv-embedded'),
        embeddedBody,
        embeddedCount
    };
}

function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// --- Embedded objects panel (issue #45) -------------------------------

function renderWorkbookPreviewMarkup(preview: WorkbookPreview): string {
    const headerCols = preview.rows[0]?.length ?? 0;
    const rowsHtml = preview.rows
        .map((row) => {
            const cells = [];
            for (let c = 0; c < Math.max(headerCols, row.length); c++) {
                const value = row[c] ?? '';
                cells.push(
                    `<td>${escapeHtml(value)}</td>`
                );
            }
            return `<tr>${cells.join('')}</tr>`;
        })
        .join('');
    const truncatedNote = preview.truncated
        ? `<div class="wv-embedded-note">Showing first ${WORD_EMBED_PREVIEW_MAX_ROWS} rows × ${WORD_EMBED_PREVIEW_MAX_COLS} columns of ${preview.totalRows} × ${preview.totalColumns}.</div>`
        : '';
    return (
        `<div class="wv-embedded-sheet-name">Sheet: ${escapeHtml(preview.sheetName)}</div>` +
        `<div class="wv-embedded-table-wrap"><table class="wv-embedded-table">${rowsHtml}</table></div>` +
        truncatedNote
    );
}

function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function makeEmbeddedItem(
    title: string,
    subtitle: string,
    bodyHtml: string
): string {
    return (
        `<section class="wv-embedded-item">` +
        `<div class="wv-embedded-item-head">` +
        `<span class="wv-embedded-item-title">${escapeHtml(title)}</span>` +
        (subtitle
            ? `<span class="wv-embedded-item-subtitle">${escapeHtml(subtitle)}</span>`
            : '') +
        `</div>` +
        `<div class="wv-embedded-item-body">${bodyHtml}</div>` +
        `</section>`
    );
}

async function renderEmbeddedPanel(
    dom: WordViewerDom,
    zip: ZipLike,
    manifest: EmbeddingsManifest
): Promise<void> {
    const totalCount = manifest.workbooks.length + manifest.charts.length;
    if (totalCount === 0) {
        dom.embeddedPanel.style.display = 'none';
        return;
    }
    dom.embeddedPanel.style.display = '';
    dom.embeddedCount.textContent = ` (${totalCount})`;
    const fragments: string[] = [];

    // Workbooks first.
    for (const wb of manifest.workbooks) {
        if (wb.extension !== 'xlsx' && wb.extension !== 'xlsm') {
            fragments.push(
                makeEmbeddedItem(
                    wb.fileName,
                    `embedded workbook (${wb.extension})`,
                    `<div class="wv-embedded-note">Preview not available for .${escapeHtml(wb.extension)} workbooks in this build.</div>`
                )
            );
            continue;
        }
        const entry = zip.file(wb.path);
        if (!entry) {
            fragments.push(
                makeEmbeddedItem(
                    wb.fileName,
                    'embedded workbook',
                    `<div class="wv-embedded-note">Workbook entry could not be located in the docx archive.</div>`
                )
            );
            continue;
        }
        try {
            const xlsxLib = await loadXlsxLib();
            const preview = await extractWorkbookPreview(entry, xlsxLib);
            fragments.push(
                makeEmbeddedItem(
                    wb.fileName,
                    'embedded workbook',
                    renderWorkbookPreviewMarkup(preview)
                )
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            fragments.push(
                makeEmbeddedItem(
                    wb.fileName,
                    'embedded workbook',
                    `<div class="wv-embedded-note wv-embedded-error">Failed to render workbook: ${escapeHtml(message)}</div>`
                )
            );
        }
    }

    // Charts second.
    for (const chart of manifest.charts) {
        const entry = zip.file(chart.path);
        if (!entry) {
            fragments.push(
                makeEmbeddedItem(
                    chart.fileName,
                    'embedded chart',
                    `<div class="wv-embedded-note">Chart entry could not be located in the docx archive.</div>`
                )
            );
            continue;
        }
        try {
            const xml = await extractChartXml(entry);
            const data = parseChartXml(xml);
            const svg = renderChartSvg(data);
            const subtitle =
                data.type === 'unsupported'
                    ? 'embedded chart (unsupported type)'
                    : `embedded chart (${data.type})`;
            fragments.push(
                makeEmbeddedItem(
                    chart.fileName,
                    subtitle,
                    `<div class="wv-embedded-chart">${svg}</div>`
                )
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            fragments.push(
                makeEmbeddedItem(
                    chart.fileName,
                    'embedded chart',
                    `<div class="wv-embedded-note wv-embedded-error">Failed to render chart: ${escapeHtml(message)}</div>`
                )
            );
        }
    }

    dom.embeddedBody.innerHTML = fragments.join('');
}

async function loadEmbeddedObjects(
    file: File,
    dom: WordViewerDom,
    isDisposed: () => boolean
): Promise<void> {
    let JSZipCtor: any;
    try {
        JSZipCtor = await loadJsZip();
    } catch {
        // No JSZip — embeddings panel stays hidden, the docx render
        // path runs separately so this is a soft failure.
        return;
    }
    if (isDisposed()) return;
    let zip: ZipLike;
    try {
        const buffer = await file.arrayBuffer();
        if (isDisposed()) return;
        zip = (await JSZipCtor.loadAsync(buffer)) as ZipLike;
    } catch {
        return;
    }
    if (isDisposed()) return;
    const manifest = scanEmbeddings(zip);
    if (manifest.workbooks.length === 0 && manifest.charts.length === 0) {
        return;
    }
    if (isDisposed()) return;
    try {
        await renderEmbeddedPanel(dom, zip, manifest);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('word viewer: failed to render embedded panel', err);
    }
}

// --- Legacy .doc rendering (issue #44) --------------------------------
//
// The legacy parser turns the WordDocument piece-table into plain HTML
// paragraphs. We don't go through docx-preview at all - we just dump
// the rendered HTML into the document container. The toolbar (zoom +
// print) keeps working because it operates against `dom.docContainer`
// directly.

async function renderLegacyDoc(
    file: File,
    dom: WordViewerDom,
    isDisposed: () => boolean
): Promise<void> {
    const buffer = await file.arrayBuffer();
    if (isDisposed()) return;
    let html: string;
    try {
        html = parseDocToHtml(buffer);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        dom.loading.style.display = 'none';
        dom.error.style.display = 'block';
        dom.error.textContent = `Failed to parse legacy .doc file: ${message}`;
        return;
    }
    if (isDisposed()) return;
    dom.docContainer.innerHTML = html;
    dom.loading.style.display = 'none';
    dom.body.style.display = 'flex';
    // Embedded objects (issue #45) only ship with .docx packages, so
    // the legacy path skips that step entirely.
}

/**
 * Mount the Word viewer into `container`. Returns synchronously with a
 * handle whose `dispose()` cleans up; the actual docx-preview render
 * happens in the background and the loading / error UI reacts to it.
 */
export function mountWordViewer(file: File, container: HTMLElement): WordViewerHandle {
    ensureStylesInjected();
    container.innerHTML = VIEWER_HTML;

    const dom = resolveDom(container);
    dom.title.textContent = file.name;
    const sizeText = formatFileSize(file.size);
    dom.fileInfo.textContent = sizeText;
    dom.zoomLevel.textContent = formatZoomLabel(WORD_DEFAULT_ZOOM_PERCENT);

    let zoomPercent = WORD_DEFAULT_ZOOM_PERCENT;
    let disposed = false;

    const applyZoom = (): void => {
        const scale = percentToScale(zoomPercent);
        dom.docContainer.style.transform = `scale(${scale})`;
        dom.zoomLevel.textContent = formatZoomLabel(zoomPercent);
        dom.zoomInBtn.disabled = !canZoomIn(zoomPercent);
        dom.zoomOutBtn.disabled = !canZoomOut(zoomPercent);
    };

    const onZoomIn = (): void => {
        const next = nextZoom(zoomPercent);
        if (next === zoomPercent) return;
        zoomPercent = next;
        applyZoom();
    };

    const onZoomOut = (): void => {
        const next = prevZoom(zoomPercent);
        if (next === zoomPercent) return;
        zoomPercent = next;
        applyZoom();
    };

    const onZoomReset = (): void => {
        zoomPercent = WORD_DEFAULT_ZOOM_PERCENT;
        applyZoom();
    };

    const onPrint = (): void => {
        if (typeof window === 'undefined') return;
        try {
            window.print();
        } catch (err) {
            // best-effort: print can be disabled in some embed contexts.
            // eslint-disable-next-line no-console
            console.warn('word viewer: window.print() failed', err);
        }
    };

    const onKeyDown = (e: KeyboardEvent): void => {
        // Match Ctrl on Windows/Linux and Cmd on macOS.
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        // `e.key` is normalized: '+' for shift+'=' on US, '=' otherwise.
        if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            onZoomIn();
        } else if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            onZoomOut();
        } else if (e.key === '0') {
            e.preventDefault();
            onZoomReset();
        } else if (e.key === 'p' || e.key === 'P') {
            // Intercept Ctrl/Cmd+P so we can guarantee `window.print()`
            // runs against our (already-rendered) document. Without the
            // preventDefault the browser still prints the page, but
            // some Chromium builds will skip the dialog if the focus
            // is inside a contentEditable / iframe within docx-preview.
            e.preventDefault();
            onPrint();
        }
    };

    dom.zoomInBtn.addEventListener('click', onZoomIn);
    dom.zoomOutBtn.addEventListener('click', onZoomOut);
    dom.zoomResetBtn.addEventListener('click', onZoomReset);
    dom.printBtn.addEventListener('click', onPrint);
    document.addEventListener('keydown', onKeyDown);

    applyZoom();

    // Kick off the async load. Errors land in the inline error panel.
    void (async () => {
        try {
            // Format dispatch (issue #44):
            //   .docx -> docx-preview render path (the original #43
            //            implementation).
            //   .doc  -> legacy CFB parser (`docBinaryParser.ts`),
            //            rendered as plain HTML paragraphs.
            //
            // We try the file extension first and only sniff bytes
            // when the extension is missing or ambiguous; this keeps
            // the common case fast.
            const format = await detectWordFormat(file);
            if (disposed) return;

            if (format === 'doc') {
                await renderLegacyDoc(file, dom, () => disposed);
                if (!disposed) applyZoom();
                return;
            }

            if (format !== 'docx') {
                // Magic-byte sniff couldn't decide. Fall back on a
                // last-ditch CFB check before erroring; some uploads
                // arrive without an extension at all.
                const headBuf = await file
                    .slice(0, 8)
                    .arrayBuffer();
                if (disposed) return;
                if (looksLikeCfbContainer(new Uint8Array(headBuf))) {
                    await renderLegacyDoc(file, dom, () => disposed);
                    if (!disposed) applyZoom();
                    return;
                }
                dom.loading.style.display = 'none';
                dom.error.style.display = 'block';
                dom.error.textContent =
                    'Unrecognised Word document format. Expected a .doc or .docx file.';
                return;
            }

            const docx = await loadDocxPreview();
            if (disposed) return;
            const buffer = await file.arrayBuffer();
            if (disposed) return;

            // Render the document into our container. `inWrapper: false`
            // keeps docx-preview from injecting an extra wrapping element
            // so our scale transform applies to the actual page content.
            await docx.renderAsync(buffer, dom.docContainer, null, {
                inWrapper: false,
                ignoreWidth: false,
                ignoreHeight: false,
                ignoreLastRenderedPageBreak: true
            });
            if (disposed) return;

            dom.loading.style.display = 'none';
            dom.body.style.display = 'flex';
            applyZoom();

            // Issue #45 — surface embedded workbooks + charts. We let
            // this run in the background; the docx-preview view above
            // is already visible so any failure here is non-fatal.
            void loadEmbeddedObjects(file, dom, () => disposed);
        } catch (err) {
            if (disposed) return;
            const message = err instanceof Error ? err.message : String(err);
            dom.loading.style.display = 'none';
            dom.error.style.display = 'block';
            dom.error.textContent = `Failed to load Word document: ${message}`;
        }
    })();

    return {
        dispose(): void {
            disposed = true;
            dom.zoomInBtn.removeEventListener('click', onZoomIn);
            dom.zoomOutBtn.removeEventListener('click', onZoomOut);
            dom.zoomResetBtn.removeEventListener('click', onZoomReset);
            dom.printBtn.removeEventListener('click', onPrint);
            document.removeEventListener('keydown', onKeyDown);
        }
    };
}

// Re-export the canonical zoom ladder so downstream issues (#44 / #45)
// can reference it without re-importing the helper module.
export { WORD_ZOOM_LEVELS_PERCENT };
