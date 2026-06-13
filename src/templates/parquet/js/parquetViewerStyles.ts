// Inline copy of `src/templates/parquet/css/parquetViewer.css`. The SPA
// host page injects this string as a `<style>` block when the viewer
// mounts inside it, mirroring the `hwpViewerStyles.ts` /
// `psdViewerStyles.ts` patterns.
//
// Keep this string in sync with the .css file alongside it. The .css
// file is the stylesheet referenced by the per-viewer
// `parquetViewer.html` debug shell.

export const PARQUET_VIEWER_CSS = `
.pv-parity-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}.pv-raw-view{flex-basis:100%;max-height:55vh;margin:0;padding:12px;overflow:auto;border:1px solid var(--pv-border,#d9dee7);border-radius:6px;background:var(--pv-panel,#fff);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}
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

.pv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    background: #2a2a2a;
    border-bottom: 1px solid #3a3a3a;
    flex: 0 0 auto;
}

.pv-title {
    font-size: 13px;
    font-weight: 500;
    color: #e8e8e8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-right: 12px;
}

.pv-meta {
    font-size: 12px;
    color: #a0a0a0;
    flex: 0 0 auto;
}

.pv-body {
    flex: 1 1 auto;
    overflow: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    background: #1e1e1e;
}

.pv-section {
    background: #252525;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    padding: 12px 16px;
}

.pv-section-title {
    font-size: 12px;
    font-weight: 600;
    color: #a0a0a0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 10px;
}

.pv-rows-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-family: 'SF Mono', Menlo, Consolas, monospace;
}

.pv-rows-table th {
    text-align: left;
    padding: 6px 10px;
    background: #2f2f2f;
    color: #c0c0c0;
    font-weight: 500;
    border-bottom: 1px solid #3a3a3a;
    position: sticky;
    top: 0;
}

.pv-rows-table td {
    padding: 6px 10px;
    border-bottom: 1px solid #303030;
    color: #d8d8d8;
    vertical-align: top;
    word-break: break-word;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
}

.pv-rows-wrap {
    overflow: auto;
    max-height: 60vh;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
}

.pv-cell-null {
    color: #777;
    font-style: italic;
}

.pv-cell-bigint {
    color: #b3d7ff;
}

.pv-cell-number {
    color: #b3d7ff;
}

.pv-cell-bool {
    color: #d2b3ff;
}

.pv-loading,
.pv-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px;
    gap: 8px;
    text-align: center;
}

.pv-loading {
    color: #a0a0a0;
    font-size: 14px;
}

.pv-error {
    color: #ff8080;
    font-size: 14px;
    background: #2b1f1f;
    border: 1px solid #5a2a2a;
    border-radius: 6px;
    margin: 24px;
}

.pv-error-title {
    font-size: 16px;
    font-weight: 600;
    color: #ffb0b0;
}

.pv-error-detail {
    font-size: 12px;
    color: #d0a0a0;
    word-break: break-word;
    max-width: 720px;
}

/* --- Rows panel: search + sort + pagination (issue #40) -------------- */

.pv-rows-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
    flex-wrap: wrap;
}

.pv-rows-title {
    margin-bottom: 0;
    flex: 1 1 auto;
}

.pv-search-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
}

.pv-search-input {
    background: #1e1e1e;
    color: #e8e8e8;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    font-family: inherit;
    min-width: 220px;
}

.pv-search-input:focus {
    outline: none;
    border-color: #5b9dff;
}

.pv-btn {
    background: #2f2f2f;
    color: #e8e8e8;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
}

.pv-btn:hover:not(:disabled) {
    background: #3a3a3a;
    border-color: #4a4a4a;
}

.pv-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.pv-th-sortable {
    cursor: pointer;
    user-select: none;
}

.pv-th-sortable:hover {
    background: #383838;
}

.pv-th-inner {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.pv-th-sort-indicator {
    color: #707070;
    font-size: 10px;
    line-height: 1;
}

.pv-th-sorted-asc .pv-th-sort-indicator,
.pv-th-sorted-desc .pv-th-sort-indicator {
    color: #5b9dff;
}

.pv-pagination {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 10px;
    flex: 0 0 auto;
}

.pv-page-info {
    font-size: 12px;
    color: #a0a0a0;
}

/* --- size guard + load more (issues #41 / #42) --------------------- */
.pv-block-panel {
    align-items: flex-start;
    gap: 12px;
}
.pv-block-detail {
    color: #cccccc;
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
}
.pv-btn-primary {
    background: #2563eb;
    border-color: #3b82f6;
    color: #fff;
}
.pv-btn-primary:hover { background: #1d4ed8; }
.pv-limit-warning,
.pv-load-more {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    margin: 12px 0 0 0;
    background: rgba(255, 200, 0, 0.06);
    border: 1px solid rgba(255, 200, 0, 0.2);
    border-radius: 6px;
}
.pv-load-more {
    background: rgba(37, 99, 235, 0.08);
    border-color: rgba(59, 130, 246, 0.25);
}
.pv-limit-message {
    font-size: 12px;
    flex: 1;
    color: #d4d4d4;
}

/* --- right-click cell context menu (#42) --------------------------- */
.pv-context-menu {
    z-index: 1100;
    min-width: 200px;
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid #3c3c3c;
    border-radius: 6px;
    padding: 4px 0;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    font-size: 12px;
}
.pv-context-menu-item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    color: inherit;
    border: 0;
    padding: 6px 12px;
    cursor: pointer;
    font: inherit;
}
.pv-context-menu-item:hover {
    background: #3a3a3a;
}
.pv-container{color:#1f2328;background:#fff}.pv-header{padding:16px 20px;background:#fff;border-color:#d0d7de}.pv-title{font-size:18px;font-weight:600;color:#1f2328}.pv-title::before{content:"📊 ";}.pv-meta{color:#656d76}.pv-body{padding:0;background:#fff;gap:0}.pv-section{padding:0;border:0;border-radius:0;background:#fff}.pv-rows-header{padding:12px 20px;border-bottom:1px solid #d0d7de;background:#f6f8fa;flex-wrap:wrap}.pv-section-title{display:none}.pv-search-input{padding:7px 10px;color:#1f2328;background:#fff;border-color:#d0d7de}.pv-btn{padding:7px 10px;color:#24292f;background:#eff2f5;border-color:#d0d7de}.pv-btn:hover{background:#e7ebef}.pv-parity-controls{margin-left:auto}.pv-raw-view{color:#1f2328;background:#fff;border-color:#d0d7de}.pv-rows-wrap{max-height:none;border:0;border-radius:0}.pv-rows-table th{background:#f6f8fa;color:#24292f;border-color:#d0d7de}.pv-rows-table td{color:#1f2328;border-color:#eaeef2}.pv-page-info{color:#656d76}.pv-pagination{justify-content:center;padding:10px 20px}.pv-context-menu{background:#fff;color:#1f2328;border-color:#d0d7de;box-shadow:0 8px 24px rgba(31,35,40,.18)}.pv-context-menu-item:hover{background:#f6f8fa}
`;
