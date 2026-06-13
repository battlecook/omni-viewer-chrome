// Inline copy of `src/templates/image/css/imageViewer.css` so the bundled
// JS module can self-inject styles when the router mounts the viewer into
// the legacy SPA's host page.
//
// This file is the single source of TRUTH-AT-RUNTIME for the viewer styles.
// `imageViewer.css` is kept alongside as a human-readable reference and as
// the stylesheet referenced by `imageViewer.html` (the per-viewer manual
// debug shell). Keep both files in sync.

export const IMAGE_VIEWER_CSS = `
.iv-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px;
    box-sizing: border-box;
    color: #e8e8e8;
}
.iv-main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
}
.iv-file-info {
    display: flex;
    align-items: center;
    gap: 18px;
    font-size: 12px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.08);
}
.iv-file-info-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
}
.iv-file-info-label {
    font-size: 10px;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.iv-file-info-value {
    font-family: 'Monaco', 'Menlo', monospace;
    font-weight: 500;
}
.iv-controls {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    flex-wrap: wrap;
}
.iv-control-group {
    display: flex;
    align-items: center;
    gap: 5px;
}
.iv-btn {
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.15s ease;
    line-height: 1.2;
}
.iv-btn:hover { background: #3a3a3a; }
.iv-btn:active { background: #444; }
.iv-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.iv-image-container {
    flex: 1;
    background: #1a1a1a;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 20px;
    position: relative;
    overflow: auto;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    min-height: 0;
    box-sizing: border-box;
}
.iv-image-wrapper {
    position: relative;
    max-width: 100%;
    transform-origin: center center;
    margin: auto;
    overflow: visible;
}
.iv-image-wrapper > img {
    max-width: 100%;
    object-fit: contain;
    transition: transform 0.2s ease;
    display: block;
    z-index: 1;
    position: relative;
}
.iv-loading {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
    width: 100%;
    font-size: 14px;
    opacity: 0.7;
}
.iv-error {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
    width: 100%;
    color: #f48771;
    text-align: center;
    padding: 20px;
}

/* --- filter UI (issue #10) ----------------------------------------- */
.iv-filter-controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
}
.iv-filter-presets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.iv-preset-btn {
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
}
.iv-preset-btn:hover { background: #3a3a3a; }
.iv-preset-btn.is-active {
    background: #2563eb;
    border-color: #3b82f6;
}
.iv-filter-sliders {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 6px 14px;
}
.iv-filter-group {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
}
.iv-filter-group label {
    min-width: 70px;
    opacity: 0.8;
}
.iv-filter-slider {
    flex: 1;
    min-width: 0;
}
.iv-filter-value {
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 11px;
    min-width: 36px;
    text-align: right;
    opacity: 0.7;
}

/* --- toggle button active state (issue #11) ------------------------ */
.iv-btn.is-active {
    background: #2563eb;
    border-color: #3b82f6;
}

/* --- edit-mode panel + tool buttons (issue #11) -------------------- */
.iv-edit-mode-host {
    /* Empty host wrapper — only takes layout space when the panel is
       mounted and visible. */
}
.iv-edit-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 10px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
}
.iv-edit-btn {
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    line-height: 1.2;
    transition: background 0.15s ease;
}
.iv-edit-btn:hover { background: #3a3a3a; }
.iv-edit-btn:active { background: #444; }
.iv-edit-btn.is-active {
    background: #2563eb;
    border-color: #3b82f6;
}
.iv-edit-btn--delete {
    background: #3a1f1f;
    border-color: rgba(244, 135, 113, 0.4);
}
.iv-edit-btn--delete:hover { background: #4a2828; }

/* --- per-tool cursor classes on the (future) edit canvas ----------- */
.iv-cursor-select { cursor: default; }
.iv-cursor-text { cursor: text; }
.iv-cursor-crosshair { cursor: crosshair; }

/* --- edit canvas + elements (issue #12) ---------------------------- */
.iv-edit-canvas {
    position: absolute;
    inset: 0;
    /* Sit on top of the image but below the controls. The image viewer
       wrapper carries z-index:1 on its <img>, so 5 keeps us comfortably
       above it without fighting the controls (z-index 'auto' / inline). */
    z-index: 5;
    /* No background of its own — the underlying image must remain visible. */
    background: transparent;
    pointer-events: auto;
    overflow: visible;
}
.iv-edit-element {
    /* Position is set inline by ElementManager (left/top/transform). The
       class only carries shared layout + z-stacking baseline. */
    box-sizing: content-box;
    user-select: none;
}
.iv-edit-text {
    /* Text elements are pure DOM — color + font-size live inline. */
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    line-height: 1.2;
    white-space: pre;
}
.iv-edit-circle, .iv-edit-rect {
    /* SVG-backed shapes — the wrapper carries no fill of its own. */
    background: transparent;
}

/* --- selection + drag-drop UI (issue #13) -------------------------- */
.iv-edit-element.is-selected {
    /* Dashed outline so the selection is visible regardless of the
       element's own fill / stroke. We use outline (not border) so the
       wrapper's box dimensions stay intact and width/height stored on
       the element data continue to match the rendered size. */
    outline: 2px dashed #3b82f6;
    outline-offset: 2px;
}
.iv-edit-action-btn {
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    line-height: 1.2;
    transition: background 0.15s ease;
}
.iv-edit-action-btn:hover { background: #3a3a3a; }
.iv-edit-action-btn:active { background: #444; }
.iv-edit-action-btn--delete-selected {
    background: #3a1f1f;
    border-color: rgba(244, 135, 113, 0.4);
}
.iv-edit-action-btn--delete-selected:hover { background: #4a2828; }
.iv-edit-action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.iv-selection-info {
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    font-size: 12px;
    color: #cbd5e1;
    opacity: 0.85;
    margin-left: 4px;
}

/* --- resize handles + properties panel (issue #14) ----------------- */
.iv-resize-handle {
    position: absolute;
    width: 8px;
    height: 8px;
    background: #2563eb;
    border: 1px solid #ffffff;
    box-sizing: border-box;
    z-index: 20000;
    pointer-events: auto;
}
.iv-resize-handle--n {
    top: 0;
    left: 50%;
    transform: translate(-50%, -50%);
    cursor: ns-resize;
}
.iv-resize-handle--s {
    top: 100%;
    left: 50%;
    transform: translate(-50%, -50%);
    cursor: ns-resize;
}
.iv-resize-handle--e {
    top: 50%;
    left: 100%;
    transform: translate(-50%, -50%);
    cursor: ew-resize;
}
.iv-resize-handle--w {
    top: 50%;
    left: 0;
    transform: translate(-50%, -50%);
    cursor: ew-resize;
}
.iv-resize-handle--ne {
    top: 0;
    left: 100%;
    transform: translate(-50%, -50%);
    cursor: nesw-resize;
}
.iv-resize-handle--nw {
    top: 0;
    left: 0;
    transform: translate(-50%, -50%);
    cursor: nwse-resize;
}
.iv-resize-handle--se {
    top: 100%;
    left: 100%;
    transform: translate(-50%, -50%);
    cursor: nwse-resize;
}
.iv-resize-handle--sw {
    top: 100%;
    left: 0;
    transform: translate(-50%, -50%);
    cursor: nesw-resize;
}
.iv-properties-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    min-width: 200px;
}
.iv-prop-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
}
.iv-prop-label {
    flex: 0 0 90px;
    opacity: 0.8;
    text-transform: capitalize;
}
.iv-prop-input {
    flex: 1;
    min-width: 0;
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 12px;
}
.iv-prop-input[type="color"] {
    padding: 0;
    height: 24px;
    cursor: pointer;
}
.iv-prop-input[type="range"] {
    padding: 0;
}
.iv-prop-value {
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 11px;
    min-width: 36px;
    text-align: right;
    opacity: 0.7;
}

/* --- save modal (issue #15) --------------------------------------- */
.iv-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: none;
    justify-content: center;
    align-items: center;
    z-index: 100000;
}
.iv-modal {
    background: #1f1f1f;
    color: #e8e8e8;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 16px 18px;
    min-width: 320px;
    max-width: 90vw;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.iv-modal-title {
    font-size: 14px;
    font-weight: 600;
}
.iv-modal-label {
    font-size: 11px;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.iv-modal-input {
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 13px;
    font-family: 'Monaco', 'Menlo', monospace;
    width: 100%;
    box-sizing: border-box;
}
.iv-modal-input:focus {
    outline: none;
    border-color: #3b82f6;
}
.iv-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
}
.iv-btn--primary {
    background: #2563eb;
    border-color: #3b82f6;
    color: #ffffff;
}
.iv-btn--primary:hover { background: #1d4ed8; }
`;
