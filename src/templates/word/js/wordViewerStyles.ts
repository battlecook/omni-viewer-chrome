// Inline copy of `src/templates/word/css/wordViewer.css` so the bundled
// JS module can self-inject styles when the router mounts the viewer
// into the legacy SPA's host page.
//
// Same pattern as `imageViewerStyles.ts` / `pdfViewerStyles.ts` /
// `excelViewerStyles.ts`. Keep this string in sync with the .css file
// alongside it; the .css file is also the stylesheet referenced by
// `wordViewer.html` (per-viewer manual debug shell).
//
// Includes a `@media print` block (issue #43) that hides the toolbar /
// header so `window.print()` produces a document-only preview.

export const WORD_VIEWER_CSS = `
.wv-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: #e8e8e8;
    background: #1e1e1e;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-sizing: border-box;
}
.wv-container *,
.wv-container *::before,
.wv-container *::after {
    box-sizing: border-box;
}
.wv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #252526;
    border-bottom: 1px solid #3c3c3c;
    flex-shrink: 0;
}
.wv-title {
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
}
.wv-file-info {
    font-size: 12px;
    color: #cccccc;
}
.wv-toolbar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 6px;
    background: #252526;
    border-bottom: 1px solid #3c3c3c;
    flex-shrink: 0;
}
.wv-icon-btn {
    width: 28px;
    height: 28px;
    font-size: 18px;
    line-height: 1;
    padding: 0;
    border: 1px solid transparent;
    background: #3c3c3c;
    color: #e8e8e8;
    border-radius: 4px;
    cursor: pointer;
}
.wv-icon-btn:hover {
    background: #4a4a4a;
}
.wv-icon-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
.wv-text-btn {
    height: 28px;
    padding: 0 12px;
    font-size: 12px;
    line-height: 1;
    border: 1px solid transparent;
    background: #3c3c3c;
    color: #e8e8e8;
    border-radius: 4px;
    cursor: pointer;
}
.wv-text-btn:hover {
    background: #4a4a4a;
}
.wv-zoom-level {
    min-width: 56px;
    text-align: center;
    font-size: 12px;
}
.wv-toolbar-spacer {
    width: 16px;
}
.wv-loading,
.wv-error {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px;
    text-align: center;
}
.wv-error {
    color: #f48771;
}
.wv-body {
    flex: 1;
    overflow: auto;
    min-height: 0;
    padding: 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
}
.wv-doc-container {
    transform-origin: top center;
    transition: transform 0.15s ease;
    background: #ffffff;
    color: #111111;
    padding: 20px 30px;
    min-width: 210mm;
    max-width: 210mm;
    min-height: 297mm;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
}
.wv-doc-container.is-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #555;
    font-style: italic;
}

/* --- embedded objects panel (issue #45) ------------------------------ */
/*
 * docx files can carry embedded Excel workbooks (word/embeddings/*.xlsx)
 * and DrawingML charts (word/charts/chart*.xml). We surface previews in
 * a collapsible details panel beneath the document. The panel lives
 * inside .wv-body so it shares the same scroll context as the doc but
 * has its own width — we cap to ~800px so wide tables do not stretch
 * out of the page.
 */
.wv-embedded {
    width: 100%;
    max-width: 800px;
    margin: 24px auto 0 auto;
    background: #2a2a2a;
    border: 1px solid #3c3c3c;
    border-radius: 6px;
    color: #e8e8e8;
    overflow: hidden;
}
.wv-embedded-summary {
    padding: 10px 14px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    background: #2f2f2f;
    user-select: none;
    list-style: none;
}
.wv-embedded-summary::-webkit-details-marker {
    display: none;
}
.wv-embedded-summary::before {
    content: '\\25B6';
    display: inline-block;
    width: 12px;
    margin-right: 6px;
    transition: transform 0.15s ease;
}
.wv-embedded[open] .wv-embedded-summary::before {
    transform: rotate(90deg);
}
.wv-embedded-count {
    color: #aaaaaa;
    font-weight: 400;
    margin-left: 4px;
}
.wv-embedded-body {
    padding: 12px 14px 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 18px;
}
.wv-embedded-item {
    background: #1f1f1f;
    border: 1px solid #3c3c3c;
    border-radius: 4px;
    padding: 10px 12px;
}
.wv-embedded-item-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 8px;
}
.wv-embedded-item-title {
    font-size: 12px;
    font-weight: 600;
    color: #ffffff;
}
.wv-embedded-item-subtitle {
    font-size: 11px;
    color: #9a9a9a;
}
.wv-embedded-item-body {
    font-size: 12px;
    color: #dddddd;
}
.wv-embedded-sheet-name {
    font-size: 11px;
    color: #999999;
    margin-bottom: 4px;
}
.wv-embedded-table-wrap {
    overflow-x: auto;
    background: #ffffff;
    border-radius: 3px;
}
.wv-embedded-table {
    border-collapse: collapse;
    font-size: 11px;
    color: #111111;
    width: auto;
}
.wv-embedded-table td {
    border: 1px solid #cccccc;
    padding: 3px 6px;
    white-space: nowrap;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
}
.wv-embedded-note {
    font-size: 11px;
    color: #aaaaaa;
    margin-top: 6px;
    font-style: italic;
}
.wv-embedded-error {
    color: #f48771;
}
.wv-embedded-chart {
    background: #ffffff;
    padding: 8px;
    border-radius: 3px;
    display: inline-block;
    max-width: 100%;
    overflow-x: auto;
}
.wv-embedded-chart svg {
    display: block;
    max-width: 100%;
    height: auto;
}

/* --- print stylesheet (issue #43) ------------------------------------ */
/*
 * When the user triggers Ctrl+P / Cmd+P / the print button we want the
 * print preview to show the document body only — no toolbar, no header,
 * no fixed-height containers. We also force the page background to
 * white and reset transforms (browsers honor scale on print, but the
 * preview makes the page run off the paper bounds otherwise).
 */
@media print {
    html, body {
        background: #ffffff !important;
        color: #000000 !important;
        height: auto !important;
        overflow: visible !important;
        margin: 0 !important;
        padding: 0 !important;
    }
    .wv-header,
    .wv-toolbar,
    .wv-loading,
    .wv-error,
    .wv-embedded {
        display: none !important;
    }
    .wv-container {
        background: #ffffff !important;
        color: #000000 !important;
        height: auto !important;
        overflow: visible !important;
    }
    .wv-body {
        overflow: visible !important;
        padding: 0 !important;
        background: #ffffff !important;
        display: block !important;
    }
    .wv-doc-container {
        transform: none !important;
        box-shadow: none !important;
        padding: 0 !important;
        min-width: auto !important;
        max-width: none !important;
        min-height: auto !important;
        background: #ffffff !important;
        color: #000000 !important;
    }
}
`;
