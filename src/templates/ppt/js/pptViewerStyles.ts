// Inline copy of `src/templates/ppt/css/pptViewer.css` so the bundled
// JS module can self-inject styles when the router mounts the viewer
// into the legacy SPA's host page. Same pattern as wordViewerStyles.ts /
// excelViewerStyles.ts. Keep this string in sync with the .css file.

export const PPT_VIEWER_CSS = `
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
.pv-file-info {
    font-size: 12px;
    color: #cccccc;
}
.pv-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: #2d2d2d;
    border-bottom: 1px solid #3c3c3c;
    flex-shrink: 0;
    font-size: 13px;
}
.pv-toolbar .pv-spacer {
    flex: 1;
}
.pv-toolbar button {
    background: #3c3c3c;
    color: #e8e8e8;
    border: 1px solid #555;
    padding: 4px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 13px;
}
.pv-toolbar button:hover:not(:disabled) {
    background: #4a4a4a;
}
.pv-toolbar button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.pv-counter {
    font-size: 13px;
    color: #cccccc;
    min-width: 64px;
    text-align: center;
}
.pv-slide-select {
    background: #3c3c3c;
    color: #e8e8e8;
    border: 1px solid #555;
    border-radius: 3px;
    padding: 3px 6px;
    font-size: 13px;
    max-width: 280px;
    cursor: pointer;
}
.pv-slide-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.pv-toolbar .pv-icon-btn {
    min-width: 28px;
    padding: 4px 8px;
    font-size: 14px;
    line-height: 1;
    text-align: center;
}
.pv-toolbar .pv-text-btn {
    padding: 4px 10px;
}
.pv-zoom-level {
    font-size: 13px;
    color: #cccccc;
    min-width: 48px;
    text-align: center;
}
.pv-loading,
.pv-error {
    padding: 16px;
    text-align: center;
    font-size: 13px;
}
.pv-error {
    color: #f48771;
}
.pv-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: #1e1e1e;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 24px;
    gap: 24px;
}
.pv-stage {
    background: #555;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    position: relative;
}
/* Continuous render mode (issue #81). The stage becomes a transparent
   flex column that owns a stream of .pv-slide articles; the per-slide
   shadow / background is moved to .pv-slide so individual slides keep
   their card appearance without compounding the stage own shadow.
   Toggled via the pv-stage data-mode continuous attribute so the
   existing one-slide mode is unaffected. */
.pv-stage[data-mode="continuous"] {
    background: transparent;
    box-shadow: none;
    overflow: visible;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    width: 100%;
    height: auto;
}
.pv-slide {
    position: relative;
    background: #555;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    scroll-margin-top: 12px;
    scroll-snap-align: start;
}
.pv-slide-host {
    transform-origin: top left;
}
.pv-slide-frame {
    color: #000000;
    font-family: Calibri, "Segoe UI", Arial, system-ui, sans-serif;
}
/* Aspect-ratio data attribute is set by the renderer (see issue #47) so
   future stylesheet tweaks can target widescreen vs. standard decks. */
.pv-slide-frame[data-aspect="4:3"] {
    /* Same intrinsic size as widescreen — kept here as a hook so future
       refinements (margins, default font sizes) can branch by aspect. */
}
.pv-shape {
    overflow: hidden;
}
.pv-shape-text {
    font-family: Calibri, "Segoe UI", Arial, system-ui, sans-serif;
}
.pv-shape-title {
    font-family: "Calibri Light", "Segoe UI", Arial, system-ui, sans-serif;
}
.pv-shape-title .pv-paragraph {
    font-weight: 600;
}
.pv-paragraph {
    word-break: break-word;
    white-space: pre-wrap;
}
.pv-bullet {
    color: inherit;
}
/* Table shapes (issue #74). Mirrors the VSCode .table-shape styling: white
   background, light grey outer border, first row rendered as <th> with a
   subtle tinted background. */
.pv-shape-table {
    background: #ffffff;
    border: 1px solid #bdbdbd;
    overflow: hidden;
}
.pv-shape-table .pv-table {
    width: 100%;
    height: 100%;
    border-collapse: collapse;
    font-size: 12px;
    color: #111111;
    table-layout: fixed;
}
.pv-shape-table .pv-table th,
.pv-shape-table .pv-table td {
    border: 1px solid #d3d3d3;
    padding: 4px 6px;
    vertical-align: top;
    word-break: break-word;
}
.pv-shape-table .pv-table th {
    background: #f2f2f2;
    font-weight: 600;
    text-align: left;
}
/* Chart shapes (issue #74). The canvas renderer paints chart/series content;
   we only need a neutral background hook and a placeholder fallback for
   unsupported chart kinds. */
.pv-shape-chart {
    background: transparent;
}
.pv-shape-chart-rendered {
    background: transparent;
    border: none;
}
/* Geometry shapes (issue #75). The renderer paints a child <svg> with fill /
   stroke / arrow markers; the wrapper must stay transparent (the previous
   placeholder branch painted a fillColor on the wrapper itself) and let
   marker overflow escape the bounding box. */
.pv-shape-geometry {
    background: transparent;
    border: none;
    overflow: visible;
}
/* Legacy .ppt (issue #48) text-only fallback. The renderer emits
   <div class="slide-frame"><div class="slide-text">…</div></div> per
   slide; we keep classnames flat (no .pv- prefix) to match the DoD on
   the issue, but add a duplicate .pv-slide-frame / .pv-slide-text class
   so the modern .pptx CSS still applies (font + background). */
.slide-frame {
    color: #000000;
    background: #ffffff;
    font-family: Calibri, "Segoe UI", Arial, system-ui, sans-serif;
}
.slide-text {
    white-space: pre-wrap;
    word-break: break-word;
}
`;
