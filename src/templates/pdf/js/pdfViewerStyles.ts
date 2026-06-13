// Inline copy of `src/templates/pdf/css/pdfViewer.css` so the bundled JS
// module can self-inject styles when the router mounts the viewer into
// the legacy SPA's host page.
//
// Same pattern as `imageViewerStyles.ts` (issue #9). Keep this string in
// sync with the .css file alongside it; the .css file is also the
// stylesheet referenced by `pdfViewer.html` (per-viewer manual debug
// shell).

export const PDF_VIEWER_CSS = `
.pv-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: #e8e8e8;
    background: #1e1e1e;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-sizing: border-box;
}
.pv-container *,
.pv-container *::before,
.pv-container *::after {
    box-sizing: border-box;
}
.pv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #252526;
    border-bottom: 1px solid #3c3c3c;
    flex-shrink: 0;
}
.pv-title {
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
}
.pv-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
}
.pv-page-info {
    font-size: 12px;
    color: #cccccc;
    margin-left: 12px;
}
.pv-zoom-controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 6px;
    background: #252526;
    border-bottom: 1px solid #3c3c3c;
    flex-shrink: 0;
}
.pv-icon-btn {
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
.pv-icon-btn:hover {
    background: #4a4a4a;
}
.pv-icon-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
.pv-zoom-level {
    min-width: 56px;
    text-align: center;
    font-size: 12px;
}
.pv-loading,
.pv-error {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px;
    text-align: center;
}
.pv-error {
    color: #f48771;
}
/* Two-pane PDF layout (issue #86): thumbnail sidebar (left) +
   document scroll port (right), each with independent vertical scroll.
   See css/pdfViewer.css for the rationale on the grid choice. */
.pv-body {
    flex: 1;
    display: grid;
    grid-template-columns: var(--pv-sidebar-width, 160px) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
    overflow: hidden;
}
.pv-thumbnail-sidebar {
    grid-column: 1;
    grid-row: 1;
    overflow-y: auto;
    overflow-x: hidden;
    border-right: 1px solid #3c3c3c;
    background: #252526;
    padding: 0;
    min-width: 0;
}
/* Backwards-compat: mountThumbnails() still toggles .is-active. Grid
   above already shows the sidebar, so this is now a no-op decoration. */
.pv-thumbnail-sidebar.is-active { /* layout handled by .pv-body grid */ }
.pv-thumbnail-help {
    position: sticky;
    top: 0;
    z-index: 2;
    padding: 8px;
    border-bottom: 1px solid #3c3c3c;
    background: #252526;
    color: #a8a8a8;
    font-size: 10px;
    line-height: 1.35;
}
.pv-thumbnail-list {
    position: relative;
    padding: 8px;
}
.pv-thumbnail-spacer {
    position: relative;
}
.pv-thumbnail-item {
    background: transparent;
    color: #e8e8e8;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 6px 4px;
    margin: 0;
    font: inherit;
    cursor: pointer;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    box-sizing: border-box;
}
.pv-thumbnail-item:hover {
    background: rgba(255, 255, 255, 0.05);
}
.pv-thumbnail-item:focus-visible {
    outline: 2px solid #3b82f6;
    outline-offset: 1px;
}
.pv-thumbnail-item.is-active-thumb {
    background: rgba(37, 99, 235, 0.18);
    border-color: rgba(59, 130, 246, 0.55);
}
.pv-thumbnail-item.pv-thumbnail-dragging {
    opacity: 0.55;
}
/* Drop indicator: a 2px line above (before) or below (after) the
   hovered thumbnail. Drawn via the ::before/::after pseudo-elements so
   the layout doesn't shift while dragging. */
.pv-thumbnail-item.pv-thumbnail-drop-before::before,
.pv-thumbnail-item.pv-thumbnail-drop-after::after {
    content: '';
    position: absolute;
    left: 4px;
    right: 4px;
    height: 2px;
    background: #3b82f6;
    border-radius: 1px;
    pointer-events: none;
}
.pv-thumbnail-item.pv-thumbnail-drop-before::before { top: 0; }
.pv-thumbnail-item.pv-thumbnail-drop-after::after { bottom: 0; }
.pv-thumbnail-canvas {
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
.pv-thumbnail-label {
    font-size: 10px;
    opacity: 0.7;
    font-family: 'Monaco', 'Menlo', monospace;
}
.pv-thumbnail-delete {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    padding: 0;
    line-height: 16px;
    font-size: 14px;
    color: #e8e8e8;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 50%;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease-in-out;
}
.pv-thumbnail-item:hover .pv-thumbnail-delete,
.pv-thumbnail-item:focus-within .pv-thumbnail-delete {
    opacity: 1;
}
.pv-thumbnail-delete:hover {
    background: #b91c1c;
    border-color: #ef4444;
    color: #fff;
}
.pv-toolbar-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

/* --- password modal (issue #18) ----------------------------------- */
.pv-modal {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
}
.pv-modal-content {
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid #3c3c3c;
    border-radius: 8px;
    padding: 18px 20px;
    width: 320px;
    max-width: 90vw;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.pv-modal-label {
    font-size: 13px;
    font-weight: 500;
}
.pv-modal-input {
    background: #1e1e1e;
    color: #e8e8e8;
    border: 1px solid #3c3c3c;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 13px;
    font-family: 'Monaco', 'Menlo', monospace;
}
.pv-modal-hint {
    font-size: 11px;
    opacity: 0.75;
}
.pv-modal-hint.is-error {
    color: #f48771;
    opacity: 1;
}
.pv-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}
.pv-btn {
    background: #3a3a3a;
    color: #e8e8e8;
    border: 1px solid #3c3c3c;
    padding: 5px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
}
.pv-btn:hover { background: #444; }
.pv-btn-primary {
    background: #2563eb;
    border-color: #3b82f6;
}
.pv-btn-primary:hover { background: #1d4ed8; }
.pv-pdf-container {
    grid-column: 2;
    grid-row: 1;
    overflow: auto;
    position: relative;
    padding: 20px;
    min-width: 0;
}
/* Narrow viewports: stack sidebar above document body so they do not
   overlap. Each pane keeps its own scroll. (No drawer toggle — see #86.) */
@media (max-width: 720px) {
    .pv-body {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: minmax(120px, 30vh) minmax(0, 1fr);
    }
    .pv-thumbnail-sidebar {
        grid-column: 1;
        grid-row: 1;
        border-right: none;
        border-bottom: 1px solid #3c3c3c;
    }
    .pv-pdf-container {
        grid-column: 1;
        grid-row: 2;
    }
}
.pv-pages-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
}
.pv-page-wrapper {
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
    background: #fff;
}
.pv-page-wrapper canvas {
    display: block;
    vertical-align: top;
}
.pv-page-placeholder {
    color: #888;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
}
.pv-overlay-layer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
}

/* --- text annotations (issue #19) --------------------------------- */
.pv-toolbar-btn {
    background: #3a3a3a;
    color: #e8e8e8;
    border: 1px solid #3c3c3c;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    gap: 4px;
}
.pv-toolbar-btn:hover { background: #444; }
.pv-toolbar-btn.is-active {
    background: #2563eb;
    border-color: #3b82f6;
    color: #fff;
}
.pv-pages-container.pv-text-mode .pv-page-wrapper,
.pv-pages-container.pv-signature-mode .pv-page-wrapper {
    cursor: crosshair;
}
.pv-annotation-text {
    position: absolute;
    pointer-events: auto;
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    transform-origin: top left;
    cursor: default;
}

/* --- signature annotations (issue #20) ---------------------------- */
.pv-annotation-signature {
    position: absolute;
    pointer-events: auto;
    user-select: none;
    transform-origin: top left;
    cursor: default;
    -webkit-user-drag: none;
}
.pv-signature-canvas-wrap {
    position: relative;
    background: #ffffff;
    border: 1px dashed #5c5c5c;
    border-radius: 4px;
    overflow: hidden;
    width: 100%;
    height: 180px;
}
.pv-signature-canvas-wrap > canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
    cursor: crosshair;
    background: #ffffff;
}
.pv-signature-clear {
    align-self: flex-start;
}
.pv-modal-row {
    display: flex;
    align-items: center;
    gap: 8px;
}
.pv-modal-row > label {
    flex: 0 0 56px;
    font-size: 12px;
    opacity: 0.85;
}
.pv-modal-row .pv-modal-input {
    flex: 1;
}
.pv-modal-input[type="number"] {
    width: 80px;
    flex: 0 0 80px;
}
.pv-modal-input[type="color"] {
    width: 36px;
    height: 28px;
    flex: 0 0 36px;
    padding: 0;
    border: 1px solid #3c3c3c;
    background: #1e1e1e;
    cursor: pointer;
}
.pv-modal-textarea {
    background: #1e1e1e;
    color: #e8e8e8;
    border: 1px solid #3c3c3c;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 13px;
    font-family: 'Monaco', 'Menlo', monospace;
    resize: vertical;
    min-height: 60px;
    width: 100%;
}
.pv-modal-content.pv-modal-content-wide {
    width: 420px;
}

/* --- selection / drag / delete (issue #21) ------------------------ */
.pv-annotation-selected {
    outline: 2px solid #3b82f6;
    outline-offset: 2px;
    box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.55);
    cursor: move;
}
.pv-annotation-selected.pv-annotation-text {
    /* Subtle background so the text content is still legible while
       selected. */
    background: rgba(59, 130, 246, 0.1);
}
.pv-annotation-context-menu {
    position: fixed;
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid #3c3c3c;
    border-radius: 4px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
    padding: 4px 0;
    min-width: 120px;
    font-size: 12px;
    z-index: 1100;
}
.pv-annotation-context-item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    color: inherit;
    border: none;
    padding: 6px 14px;
    cursor: pointer;
    font: inherit;
}
.pv-annotation-context-item:hover {
    background: #3a3a3a;
}
`;
