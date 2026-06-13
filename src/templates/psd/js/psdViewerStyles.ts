// Inline copy of `src/templates/psd/css/psdViewer.css` so the bundled
// JS module can self-inject styles when the router mounts the viewer
// into the legacy SPA's host page.
//
// Same pattern as `pdfViewerStyles.ts` (issue #16). Keep this string in
// sync with the .css file alongside it; the .css file is also the
// stylesheet referenced by the per-viewer `psdViewer.html` debug shell.
//
// Layer panel styles (issue #51) live below the composite/canvas
// rules; they cover `.psv-main`, `.psv-sidebar`, `.psd-layer-tree`,
// `.psd-layer-row`, `.psd-layer-eye` (+ `.is-hidden`), and the
// per-row name label.
//
// View-modal styles (issue #52) live at the bottom and cover
// `.psd-modal`, `.psd-modal-content`, `.psd-modal-header`,
// `.psd-modal-close`, `.psd-modal-stage`, `.psd-modal-canvas-wrap`,
// `.psd-modal-canvas`, plus the pure-CSS `.psd-checkerboard`
// transparent-area background.

export const PSD_VIEWER_CSS = `
.psv-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: #e8e8e8;
    background: #1e1e1e;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-sizing: border-box;
}
.psv-container *,
.psv-container *::before,
.psv-container *::after {
    box-sizing: border-box;
}
.psv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #252526;
    border-bottom: 1px solid #3c3c3c;
    flex-shrink: 0;
}
.psv-title {
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
}
.psv-meta {
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: 12px;
    color: #cccccc;
}
.psv-meta-item {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
}
.psv-meta-label {
    opacity: 0.7;
}
.psv-meta-value {
    font-family: 'Monaco', 'Menlo', monospace;
    color: #e8e8e8;
}
.psv-main {
    flex: 1;
    display: flex;
    flex-direction: row;
    min-height: 0;
    overflow: hidden;
}
.psv-sidebar {
    width: 240px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: #252526;
    border-right: 1px solid #3c3c3c;
    overflow: hidden;
}
.psv-sidebar-header {
    padding: 8px 12px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #cccccc;
    background: #2d2d30;
    border-bottom: 1px solid #3c3c3c;
    flex-shrink: 0;
}
.psd-layer-tree {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 0;
    font-size: 12px;
    color: #e8e8e8;
}
.psd-layer-tree-empty {
    padding: 12px;
    text-align: center;
    font-size: 12px;
    color: #888;
    font-style: italic;
}
.psd-layer-row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding-right: 8px;
    cursor: default;
    user-select: none;
}
.psd-layer-row:hover {
    background: #2a2d2e;
}
.psd-layer-row.is-group .psd-layer-name {
    font-weight: 600;
}
.psd-layer-eye {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    color: #d8d8d8;
    cursor: pointer;
    border-radius: 3px;
    flex-shrink: 0;
}
.psd-layer-eye:hover {
    background: #3c3c3c;
}
.psd-layer-eye:focus-visible {
    outline: 1px solid #0a84ff;
    outline-offset: 1px;
}
.psd-layer-eye.is-hidden {
    color: #666;
}
.psd-layer-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.psd-layer-view {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    color: #d8d8d8;
    cursor: pointer;
    border-radius: 3px;
    flex-shrink: 0;
    font-size: 13px;
    line-height: 1;
}
.psd-layer-view:hover {
    background: #3c3c3c;
}
.psd-layer-view:focus-visible {
    outline: 1px solid #0a84ff;
    outline-offset: 1px;
}
.psd-layer-view:disabled {
    color: #555;
    cursor: not-allowed;
}
.psv-body {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 20px;
    min-height: 0;
    /* Subtle dark backdrop so transparent PSDs read as transparent.
       A proper checkerboard arrives in issue #52. */
    background: #1a1a1a;
}
.psv-canvas-wrapper {
    display: inline-block;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
    background: #000;
    max-width: 100%;
}
.psv-canvas-wrapper canvas {
    display: block;
    max-width: 100%;
    height: auto;
    vertical-align: top;
}
.psv-loading,
.psv-error,
.psv-warning {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 40px;
    text-align: center;
    font-size: 13px;
}
.psv-error {
    color: #f48771;
}
.psv-warning {
    color: #d4b85a;
}
.psv-error-detail,
.psv-warning-detail {
    font-size: 12px;
    opacity: 0.85;
    max-width: 520px;
    word-break: break-word;
}

/* ----- View modal (issue #52) -------------------------------------- */

.psd-modal {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.72);
    padding: 24px;
    box-sizing: border-box;
}
.psd-modal *,
.psd-modal *::before,
.psd-modal *::after {
    box-sizing: border-box;
}
.psd-modal-content {
    display: flex;
    flex-direction: column;
    max-width: 100%;
    max-height: 100%;
    min-width: 0;
    min-height: 0;
    background: #1e1e1e;
    border: 1px solid #3c3c3c;
    border-radius: 6px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    overflow: hidden;
    color: #e8e8e8;
}
.psd-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #252526;
    border-bottom: 1px solid #3c3c3c;
    flex-shrink: 0;
}
.psd-modal-title {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 80%;
}
.psd-modal-close {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    padding: 0;
    color: #d8d8d8;
    cursor: pointer;
    border-radius: 3px;
    font-size: 14px;
    line-height: 1;
}
.psd-modal-close:hover {
    background: #3c3c3c;
}
.psd-modal-close:focus-visible {
    outline: 1px solid #0a84ff;
    outline-offset: 1px;
}
.psd-modal-stage {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 16px;
    background: #1a1a1a;
}
.psd-modal-canvas-wrap {
    display: inline-block;
    max-width: 100%;
    max-height: 100%;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
    /* The wrap carries the checkerboard so any "letterbox" padding
       between the canvas and the wrap (when the canvas is smaller
       than its max-size box) still reads as "transparent". */
}
.psd-modal-canvas {
    display: block;
    max-width: 100%;
    max-height: 100%;
    height: auto;
    width: auto;
    vertical-align: top;
    /* Image-rendering: pixelated keeps the per-pixel structure
       readable when the user zooms in via the browser. */
    image-rendering: pixelated;
}

/* Pure-CSS 8x8 px checkerboard via two crossed linear-gradients.
   Light / dark squares are the conventional Photoshop transparency
   tones. We pin the size at 8px so the pattern stays readable even
   when the canvas is scaled up by max-width clamping. */
.psd-checkerboard {
    background-color: #ffffff;
    background-image:
        linear-gradient(45deg, #c8c8c8 25%, transparent 25%, transparent 75%, #c8c8c8 75%),
        linear-gradient(45deg, #c8c8c8 25%, transparent 25%, transparent 75%, #c8c8c8 75%);
    background-size: 16px 16px;
    background-position: 0 0, 8px 8px;
}
`;
