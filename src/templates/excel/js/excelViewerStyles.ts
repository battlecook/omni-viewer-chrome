// Inline copy of `src/templates/excel/css/excelViewer.css` so the bundled
// JS module can self-inject styles when the router mounts the viewer into
// the legacy SPA's host page. Same pattern as image/pdf/csv viewers.

export const EXCEL_VIEWER_CSS = `
.xv-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: #e8e8e8;
    background: #1e1e1e;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.xv-container *,
.xv-container *::before,
.xv-container *::after {
    box-sizing: border-box;
}
.xv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #252526;
    border-bottom: 1px solid #3c3c3c;
    flex-shrink: 0;
}
.xv-title {
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 50%;
}
.xv-file-info {
    font-size: 12px;
    opacity: 0.7;
    display: flex;
    gap: 6px;
    align-items: center;
}
.xv-controls {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    background: #252526;
    border-bottom: 1px solid #3c3c3c;
    flex-wrap: wrap;
}
.xv-sheet-selector-container {
    display: flex;
    align-items: center;
    gap: 6px;
}
.xv-sheet-label {
    font-size: 12px;
    opacity: 0.8;
}
.xv-sheet-select {
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid #3c3c3c;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
}
.xv-search-container {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 220px;
}
.xv-search-input {
    flex: 1;
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid #3c3c3c;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    min-width: 0;
}
.xv-btn {
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid #3c3c3c;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
}
.xv-btn:hover { background: #3a3a3a; }
.xv-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.xv-btn.is-flashing {
    background: #2563eb;
    border-color: #2563eb;
    color: #fff;
}
.xv-export-container {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}
.xv-table-container {
    flex: 1;
    overflow: auto;
    position: relative;
    padding: 0 12px;
    min-height: 0;
}
.xv-loading,
.xv-error {
    padding: 16px;
    font-size: 13px;
    opacity: 0.8;
}
.xv-error {
    color: #f48771;
}
.xv-table-wrapper {
    overflow: auto;
    height: 100%;
}
.xv-table {
    border-collapse: collapse;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 12px;
    width: max-content;
    min-width: 100%;
}
.xv-table th,
.xv-table td {
    border: 1px solid #3c3c3c;
    padding: 4px 8px;
    text-align: left;
    vertical-align: top;
    white-space: nowrap;
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
}
.xv-table th {
    position: sticky;
    top: 0;
    background: #2c2c2c;
    z-index: 1;
    font-weight: 600;
}
.xv-table tbody tr:hover {
    background: rgba(255, 255, 255, 0.04);
}
.xv-table tbody tr.is-search-hit td {
    background: rgba(37, 99, 235, 0.12);
}
.xv-pagination {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    border-top: 1px solid #3c3c3c;
    background: #252526;
    font-size: 12px;
    flex-shrink: 0;
}
.xv-pagination .xv-page-info {
    margin-left: auto;
    margin-right: auto;
    opacity: 0.8;
}
.xv-raw-data-wrapper {
    overflow: auto;
    height: 100%;
    background: #1e1e1e;
    border: 1px solid #3c3c3c;
    border-radius: 4px;
    padding: 0;
    box-sizing: border-box;
}
.xv-raw-data {
    margin: 0;
    padding: 12px;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 12px;
    line-height: 1.5;
    color: #e8e8e8;
    white-space: pre;
    tab-size: 2;
    -moz-tab-size: 2;
}
.xv-search-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
`;
