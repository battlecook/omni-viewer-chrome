// Inline copy of `src/templates/json/css/jsonViewer.css` so the bundled JS
// module can self-inject styles when the router mounts the viewer into the
// legacy SPA host. Keep this string in sync with the .css file.

export const JSON_VIEWER_CSS = `
.jv-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px;
    box-sizing: border-box;
    color: #e8e8e8;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 13px;
}
.jv-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    margin-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.jv-actions{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid #d9dee7;background:#f8fafc}.jv-result{margin:10px 12px;border:1px solid #d9dee7;border-radius:6px;background:#fff;overflow:hidden}.jv-result-header{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-bottom:1px solid #d9dee7;background:#f8fafc}.jv-result-output{max-height:280px;margin:0;padding:12px;overflow:auto;white-space:pre-wrap;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.jv-search {
    flex: 1;
    min-width: 200px;
    padding: 6px 10px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    color: #e8e8e8;
    font-family: inherit;
    font-size: 12px;
    outline: none;
}
.jv-search:focus {
    border-color: rgba(120, 170, 255, 0.6);
    box-shadow: 0 0 0 2px rgba(120, 170, 255, 0.18);
}
.jv-match-info {
    font-size: 12px;
    opacity: 0.75;
    min-width: 80px;
    text-align: right;
}
.jv-button {
    padding: 4px 10px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    color: #e8e8e8;
    font: inherit;
    cursor: pointer;
}
.jv-button:hover {
    background: rgba(255, 255, 255, 0.10);
}
.jv-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}
.jv-tree {
    flex: 1;
    overflow: auto;
    min-height: 0;
    padding: 4px 0;
}
.jv-error {
    padding: 12px;
    border: 1px solid rgba(255, 100, 100, 0.4);
    border-radius: 4px;
    background: rgba(255, 100, 100, 0.08);
    color: #ffb0b0;
    white-space: pre-wrap;
    word-break: break-word;
}
.jv-node {
    display: block;
}
.jv-row {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 1px 6px;
    line-height: 1.5;
    cursor: default;
    border-radius: 3px;
}
.jv-row.jv-toggleable {
    cursor: pointer;
}
.jv-row:hover {
    background: rgba(255, 255, 255, 0.04);
}
.jv-row.jv-current {
    background: rgba(255, 200, 80, 0.18);
    outline: 1px solid rgba(255, 200, 80, 0.5);
}
.jv-toggle {
    display: inline-block;
    width: 14px;
    text-align: center;
    color: rgba(255, 255, 255, 0.55);
    user-select: none;
    flex-shrink: 0;
}
.jv-toggle.jv-leaf {
    visibility: hidden;
}
.jv-key {
    color: #a3d1ff;
    flex-shrink: 0;
}
.jv-key.jv-array-index {
    color: rgba(255, 255, 255, 0.45);
}
.jv-colon {
    color: rgba(255, 255, 255, 0.45);
    margin-right: 4px;
}
.jv-summary {
    color: rgba(255, 255, 255, 0.45);
    font-style: italic;
}
.jv-value {
    word-break: break-word;
    overflow-wrap: anywhere;
    flex: 1;
    min-width: 0;
}
.jv-value-string { color: #ffb86c; }
.jv-value-number { color: #f1fa8c; }
.jv-value-boolean { color: #ff79c6; }
.jv-value-null { color: rgba(255, 255, 255, 0.4); }
.jv-children {
    display: block;
    border-left: 1px dashed rgba(255, 255, 255, 0.08);
    margin-left: 9px;
}
.jv-match-highlight {
    background: rgba(255, 235, 130, 0.22);
    border-radius: 2px;
}
.jv-mode-group {
    display: inline-flex;
    gap: 4px;
}
.jv-mode-button {
    padding: 4px 10px;
}
.jv-mode-button.jv-mode-active {
    background: rgba(120, 170, 255, 0.18);
    border-color: rgba(120, 170, 255, 0.55);
    color: #ffffff;
}
.jv-source {
    flex: 1;
    overflow: auto;
    min-height: 0;
    padding: 4px 0;
}
.jv-source-pre {
    margin: 0;
    padding: 8px 12px;
    font-family: inherit;
    font-size: inherit;
    line-height: 1.5;
    color: #e8e8e8;
    white-space: pre;
    tab-size: 2;
}
.jv-source-code {
    font-family: inherit;
}
.jv-tok-key { color: #a3d1ff; }
.jv-tok-string { color: #ffb86c; }
.jv-tok-number { color: #f1fa8c; }
.jv-tok-bool { color: #ff79c6; }
.jv-tok-null { color: rgba(255, 255, 255, 0.55); }
.jv-tok-punct { color: rgba(255, 255, 255, 0.65); }
.jv-tok-unknown {
    color: #ff8080;
    text-decoration: underline wavy rgba(255, 100, 100, 0.6);
}
.jv-host{height:100%;min-height:0;background:#fff;color:#1f2328}
.jv-container{height:auto;min-height:100%;padding:18px;gap:14px;overflow:auto;box-sizing:border-box;color:#1f2328;background:#fff;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.jv-header,.jv-panel-header,.jv-result-actions{display:flex;align-items:center;gap:10px}.jv-header{align-items:flex-start;justify-content:space-between}.jv-title{font-size:16px;font-weight:600;margin-bottom:4px}.jv-subtitle,.jv-panel-header span:last-child{color:#656d76;font-size:12px}.jv-status{padding:7px 10px;border:1px solid #d0d7de;border-radius:999px;background:#ddf4ff;color:#0550ae;font-size:12px;font-weight:600}.jv-status.is-valid{background:#dafbe1;color:#1a7f37}.jv-status.is-invalid{background:#ffebe9;color:#cf222e}
.jv-toolbar{padding:0;margin:0;border:0}.jv-actions{display:flex;gap:10px;padding:0;border:0;background:transparent}.jv-action-group,.jv-mode-group{display:flex;gap:10px;flex-wrap:wrap;padding:7px;border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa}.jv-button{padding:7px 10px;border:1px solid #d0d7de;border-radius:6px;background:#eff2f5;color:#24292f;font:inherit}.jv-button:hover{background:#e7ebef}.jv-mode-button.jv-mode-active{border-color:#0969da;background:#ddf4ff;color:#1f2328}
.jv-result{margin:0;border:1px solid #d0d7de;border-radius:8px}.jv-result-header,.jv-panel-header{display:flex;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #d0d7de;background:#f6f8fa}.jv-result-output{max-height:260px;margin:0;padding:14px;color:#1f2328;background:#fff}
.jv-workspace{display:grid;grid-template-columns:minmax(320px,1fr) minmax(320px,1fr);gap:14px;min-height:66vh}.jv-panel{display:flex;flex-direction:column;min-height:0;border:1px solid #d0d7de;border-radius:8px;overflow:hidden;background:#fff}.jv-editor{flex:1;min-height:0;resize:none;border:0;outline:0;padding:16px;color:#1f2328;background:#fff;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.jv-search-bar{display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid #d0d7de}.jv-search{color:#1f2328;background:#fff;border-color:#d0d7de}.jv-tree,.jv-source{padding:12px;box-sizing:border-box;color:#1f2328}.jv-row:hover{background:#f6f8fa}.jv-key{color:#0550ae}.jv-value-string{color:#0a7f36}.jv-value-number{color:#953800}.jv-value-boolean{color:#8250df}.jv-value-null,.jv-toggle,.jv-colon,.jv-summary{color:#656d76}.jv-source-pre{color:#1f2328}
@media(max-width:760px){.jv-container{padding:12px}.jv-header{flex-wrap:wrap}.jv-workspace{grid-template-columns:minmax(0,1fr)}}
`;
