// Inline copy of `src/templates/yaml/css/yamlViewer.css` so the bundled
// JS module can self-inject styles when the router mounts the viewer
// into the legacy SPA host. Keep this string in sync with the .css file.

export const YAML_VIEWER_CSS = `
.yv-container {
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
.yv-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    margin-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-wrap: wrap;
}
.yv-mode-group {
    display: inline-flex;
    gap: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    overflow: hidden;
}
.yv-mode-button {
    padding: 4px 10px;
    background: transparent;
    border: none;
    color: #e8e8e8;
    font: inherit;
    cursor: pointer;
}
.yv-mode-button:hover { background: rgba(255, 255, 255, 0.06); }
.yv-mode-button.is-active {
    background: rgba(120, 170, 255, 0.18);
    color: #ffffff;
}
.yv-search {
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
.yv-search:focus {
    border-color: rgba(120, 170, 255, 0.6);
    box-shadow: 0 0 0 2px rgba(120, 170, 255, 0.18);
}
.yv-match-info {
    font-size: 12px;
    opacity: 0.75;
    min-width: 80px;
    text-align: right;
}
.yv-button {
    padding: 4px 10px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    color: #e8e8e8;
    font: inherit;
    cursor: pointer;
}
.yv-button:hover { background: rgba(255, 255, 255, 0.10); }
.yv-button:disabled { opacity: 0.4; cursor: not-allowed; }
.yv-content {
    flex: 1;
    overflow: auto;
    min-height: 0;
    padding: 4px 0;
}
.yv-source {
    flex: 1;
    overflow: auto;
    min-height: 0;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 4px;
    white-space: pre;
    word-break: normal;
    color: #e8e8e8;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 12px;
    margin: 0;
}
.yv-source-token-key { color: #8be9fd; font-weight: 600; }
.yv-source-token-string { color: #ffb86c; }
.yv-source-token-number { color: #f1fa8c; }
.yv-source-token-boolean { color: #ff79c6; }
.yv-source-token-null { color: rgba(255, 255, 255, 0.45); font-style: italic; }
.yv-source-token-comment { color: rgba(255, 255, 255, 0.42); font-style: italic; }
.yv-source-token-punctuation { color: rgba(255, 255, 255, 0.55); }
.yv-source-token-value { color: #ffb86c; }
.yv-error {
    padding: 12px;
    border: 1px solid rgba(255, 100, 100, 0.4);
    border-radius: 4px;
    background: rgba(255, 100, 100, 0.08);
    color: #ffb0b0;
    white-space: pre-wrap;
    word-break: break-word;
}
.yv-node { display: block; }
.yv-row {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 1px 6px;
    line-height: 1.5;
    cursor: default;
    border-radius: 3px;
}
.yv-row.yv-toggleable { cursor: pointer; }
.yv-row:hover { background: rgba(255, 255, 255, 0.04); }
.yv-row.yv-current {
    background: rgba(255, 200, 80, 0.18);
    outline: 1px solid rgba(255, 200, 80, 0.5);
}
.yv-toggle {
    display: inline-block;
    width: 14px;
    text-align: center;
    color: rgba(255, 255, 255, 0.55);
    user-select: none;
    flex-shrink: 0;
}
.yv-toggle.yv-leaf { visibility: hidden; }
.yv-key { color: #a3d1ff; flex-shrink: 0; }
.yv-key.yv-array-index { color: rgba(255, 255, 255, 0.45); }
.yv-colon {
    color: rgba(255, 255, 255, 0.45);
    margin-right: 4px;
}
.yv-summary {
    color: rgba(255, 255, 255, 0.45);
    font-style: italic;
}
.yv-value {
    word-break: break-word;
    overflow-wrap: anywhere;
    flex: 1;
    min-width: 0;
}
.yv-value-string { color: #ffb86c; }
.yv-value-number { color: #f1fa8c; }
.yv-value-boolean { color: #ff79c6; }
.yv-value-null { color: rgba(255, 255, 255, 0.4); }
.yv-value-alias { color: #c8a8ff; }
.yv-children {
    display: block;
    border-left: 1px dashed rgba(255, 255, 255, 0.08);
    margin-left: 9px;
}
.yv-match-highlight {
    background: rgba(255, 235, 130, 0.22);
    border-radius: 2px;
}
.yv-anchor-chip {
    display: inline-block;
    margin-left: 6px;
    padding: 0 6px;
    background: rgba(120, 200, 255, 0.18);
    color: #b8e0ff;
    border-radius: 8px;
    font-size: 11px;
}
.yv-alias-chip {
    display: inline-block;
    margin-left: 6px;
    padding: 0 6px;
    background: rgba(200, 168, 255, 0.18);
    color: #d8c0ff;
    border-radius: 8px;
    font-size: 11px;
}
.yv-host{height:100%;min-height:0;background:#fff;color:#1f2328}.yv-container{height:auto;min-height:100%;padding:18px;gap:14px;overflow:auto;box-sizing:border-box;background:#fff;color:#1f2328;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.yv-header,.yv-panel-header,.yv-panel-actions{display:flex;align-items:center;gap:10px}.yv-header{align-items:flex-start;justify-content:space-between}.yv-title{font-size:16px;font-weight:600;margin-bottom:4px}.yv-subtitle,.yv-panel-header span:last-child,.yv-match-info{color:#656d76;font-size:12px}.yv-badge{padding:7px 10px;border:1px solid #d0d7de;border-radius:999px;background:#ddf4ff;color:#0550ae;font-size:12px;font-weight:600}
.yv-toolbar{padding:0;margin:0;border:0;gap:10px}.yv-mode-group{gap:10px;padding:7px;border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa;overflow:visible}.yv-mode-button,.yv-button{padding:7px 10px;border:1px solid #d0d7de;border-radius:6px;background:#eff2f5;color:#24292f;font:inherit}.yv-mode-button.is-active{border-color:#0969da;background:#ddf4ff;color:#1f2328}.yv-search{padding:7px 10px;color:#1f2328;background:#fff;border-color:#d0d7de}
.yv-workspace{display:grid;grid-template-columns:minmax(320px,1fr) minmax(320px,1fr);gap:14px;min-height:66vh}.yv-panel{display:flex;flex-direction:column;min-height:0;border:1px solid #d0d7de;border-radius:8px;overflow:hidden;background:#fff}.yv-panel-header{justify-content:space-between;padding:12px 14px;border-bottom:1px solid #d0d7de;background:#f6f8fa}.yv-content,.yv-source{flex:1;box-sizing:border-box;padding:16px;color:#1f2328;background:#fff;border-radius:0}.yv-row:hover{background:#f6f8fa}.yv-key{color:#0550ae}.yv-value-string{color:#0a7f36}.yv-value-number{color:#953800}.yv-value-boolean{color:#8250df}.yv-value-null,.yv-toggle,.yv-colon,.yv-summary{color:#656d76}
@media(max-width:760px){.yv-container{padding:12px}.yv-header{flex-wrap:wrap}.yv-workspace{grid-template-columns:minmax(0,1fr)}}
`;
