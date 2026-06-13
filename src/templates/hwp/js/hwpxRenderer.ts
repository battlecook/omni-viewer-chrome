// HWPX → DOM renderer. Issue #54.
//
// Consumes the AST produced by `src/utils/hwpDocumentParser.ts` and
// renders each page as a `.hv-page` card containing
// `.hwp-paragraph` divs and `.hwp-table` tables.
//
// The styling rides on top of the existing `.hv-*` styles in
// `hwpViewerStyles.ts` (#53). The rhwp WASM path emits SVG strings; we
// emit DOM nodes here, but we share the page card chrome so HWPX and
// HWP look consistent in the SPA.
//
// All builders use `document.createElement` + `textContent` (no
// innerHTML) — the AST is derived from user input (the HWPX file), so
// we treat its text as untrusted and let the browser handle escaping.
//
// Pure functions: callers pass the host element. No global state.

import type {
    HwpLayoutBlock,
    HwpLayoutDocument,
    HwpLayoutPage,
    HwpLayoutParagraph,
    HwpLayoutRun,
    HwpLayoutTableBlock,
} from '../../../utils/hwpDocumentTypes';

/**
 * Render a parsed HWPX document into `host`. Replaces the host's
 * existing children. Returns the number of pages rendered for callers
 * that want to surface the count in the meta line.
 */
export function renderHwpxDocument(
    document: HwpLayoutDocument,
    host: HTMLElement
): number {
    host.replaceChildren();
    for (const page of document.pages) {
        host.appendChild(renderHwpxPage(page));
    }
    return document.pages.length;
}

/**
 * Render a single page as an `.hv-page` card. Each block (paragraph or
 * table) becomes a child of the page card so the existing page-card
 * styling (white background, shadow) wraps the whole page.
 */
export function renderHwpxPage(page: HwpLayoutPage): HTMLElement {
    const pageEl = window.document.createElement('div');
    pageEl.className = 'hv-page hwpx-page';
    pageEl.setAttribute('data-page-index', String((page.sectionIndex ?? 1) - 1));

    const inner = window.document.createElement('div');
    inner.className = 'hwpx-page-inner';
    pageEl.appendChild(inner);

    for (const block of page.blocks) {
        inner.appendChild(renderBlock(block));
    }
    return pageEl;
}

function renderBlock(block: HwpLayoutBlock): HTMLElement {
    if (block.kind === 'table') {
        return renderTable(block);
    }
    return renderParagraph(block);
}

/**
 * Render a paragraph as `<div class="hwp-paragraph">` with one
 * `<span>` per run. We map the AST style fields to inline styles —
 * inline styles are intentional here because HWPX writes per-run
 * formatting and we don't want to crank a class taxonomy for every
 * (size × color) combination.
 */
export function renderParagraph(paragraph: HwpLayoutParagraph): HTMLElement {
    const div = window.document.createElement('div');
    div.className = 'hwp-paragraph';
    div.setAttribute('data-paragraph-id', paragraph.id);
    div.style.textAlign = paragraph.align;
    div.style.lineHeight = String(paragraph.lineHeight);
    if (paragraph.fontSizePt) {
        div.style.fontSize = `${paragraph.fontSizePt}pt`;
    }

    if (paragraph.runs.length === 0) {
        // Preserve empty paragraphs as a non-collapsing block — useful
        // for HWPX documents that use blank paragraphs as spacing.
        div.appendChild(window.document.createElement('br'));
        return div;
    }

    for (const run of paragraph.runs) {
        div.appendChild(renderRun(run));
    }
    return div;
}

function renderRun(run: HwpLayoutRun): HTMLElement {
    const span = window.document.createElement('span');
    span.className = 'hwp-run';
    span.textContent = run.text;

    if (run.fontSizePt) {
        span.style.fontSize = `${run.fontSizePt}pt`;
    }
    if (run.fontWeight) {
        span.style.fontWeight = run.fontWeight;
    }
    if (run.fontStyle) {
        span.style.fontStyle = run.fontStyle;
    }
    if (run.textDecoration) {
        span.style.textDecoration = run.textDecoration;
    }
    if (run.color) {
        span.style.color = run.color;
    }
    if (run.backgroundColor) {
        span.style.backgroundColor = run.backgroundColor;
    }
    if (run.verticalAlign === 'super') {
        span.style.verticalAlign = 'super';
        span.style.fontSize = '0.75em';
    } else if (run.verticalAlign === 'sub') {
        span.style.verticalAlign = 'sub';
        span.style.fontSize = '0.75em';
    }
    return span;
}

/**
 * Render a table as a basic `<table>`. We use semantic `<table>` /
 * `<tr>` / `<td>` so users can copy / inspect, and so colSpan / rowSpan
 * survive the round-trip from the AST.
 */
export function renderTable(table: HwpLayoutTableBlock): HTMLElement {
    const tableEl = window.document.createElement('table');
    tableEl.className = 'hwp-table';
    tableEl.setAttribute('data-table-id', table.id);

    const tbody = window.document.createElement('tbody');
    tableEl.appendChild(tbody);

    for (const row of table.rows) {
        const tr = window.document.createElement('tr');
        for (const cell of row.cells) {
            const td = window.document.createElement('td');
            td.setAttribute('data-cell-id', cell.id);
            if (cell.colSpan && cell.colSpan > 1) {
                td.colSpan = cell.colSpan;
            }
            if (cell.rowSpan && cell.rowSpan > 1) {
                td.rowSpan = cell.rowSpan;
            }
            if (cell.backgroundColor) {
                td.style.backgroundColor = cell.backgroundColor;
            }
            if (cell.borderColor) {
                td.style.borderColor = cell.borderColor;
            }
            if (cell.textAlign) {
                td.style.textAlign = cell.textAlign;
            }
            for (const paragraph of cell.paragraphs) {
                td.appendChild(renderParagraph(paragraph));
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    return tableEl;
}

/**
 * Style block injected alongside the existing HWP viewer CSS. Mirrors
 * the dark-shell-light-page approach in `hwpViewerStyles.ts`. Kept
 * separate so HWPX-specific styles don't bloat the rhwp path.
 */
export const HWPX_RENDERER_CSS = `
.hv-page.hwpx-page {
    width: min(820px, 100%);
    padding: 0;
    overflow: hidden;
}

.hwpx-page-inner {
    padding: 48px 56px;
    color: #111111;
    font-size: 11pt;
    line-height: 1.65;
    box-sizing: border-box;
}

.hwp-paragraph {
    margin: 0 0 0.45em 0;
    white-space: pre-wrap;
    word-break: break-word;
}

.hwp-paragraph:last-child {
    margin-bottom: 0;
}

.hwp-run {
    /* Inline run; styling comes from the AST through inline styles. */
}

.hwp-table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.6em 0;
    font-size: inherit;
}

.hwp-table td {
    border: 1px solid #c0c0c0;
    padding: 4pt 6pt;
    vertical-align: top;
}
`;
