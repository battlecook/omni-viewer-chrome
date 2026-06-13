// Runtime CSS injected by the TOML viewer (issue #65).
//
// We keep this in a separate module so the entry bundle can append it to the
// page on first render without forcing the host HTML to import an extra
// stylesheet. The standalone `tomlViewer.html` shell does load the static
// `css/tomlViewer.css` for back-compat with manual debugging, but the bundled
// `mountTomlViewer` factory injects this string so the viewer also works when
// embedded by the registry-driven router (which only owns a container, not a
// `<head>`).

export const TOML_VIEWER_RUNTIME_CSS = `
.toml-viewer-host {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #1f2933;
    background: #f8fafc;
}
.toml-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
}
.toml-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background: #ffffff;
    border-bottom: 1px solid #e2e8f0;
}
.toml-title {
    font-weight: 600;
    font-size: 13px;
    color: #0f172a;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.toml-file-info {
    font-size: 11px;
    color: #64748b;
    white-space: nowrap;
}
.toml-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: #f1f5f9;
    border-bottom: 1px solid #e2e8f0;
}
.toml-search {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    font-size: 12px;
    background: #ffffff;
    color: #0f172a;
}
.toml-button {
    padding: 6px 12px;
    border: 1px solid #cbd5e1;
    background: #ffffff;
    color: #0f172a;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
}
.toml-button:hover {
    background: #f8fafc;
}
.toml-button.is-active {
    background: #2563eb;
    color: #ffffff;
    border-color: #2563eb;
}
.toml-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: #ffffff;
}
.toml-tree {
    padding: 12px 16px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.55;
}
.toml-node {
    display: block;
}
.toml-node.is-hidden {
    display: none;
}
.toml-node-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 0;
    cursor: default;
}
.toml-node-row.is-clickable {
    cursor: pointer;
}
.toml-node-row.is-clickable:hover {
    background: #f1f5f9;
}
.toml-disclosure {
    display: inline-block;
    width: 12px;
    text-align: center;
    color: #64748b;
    user-select: none;
}
.toml-disclosure.is-empty {
    visibility: hidden;
}
.toml-key {
    color: #0f172a;
    font-weight: 600;
}
.toml-key-table {
    color: #1d4ed8;
}
.toml-key-aot {
    color: #7c3aed;
}
.toml-equals {
    color: #94a3b8;
    margin: 0 4px;
}
.toml-value {
    color: #0f172a;
}
.toml-value-string { color: #047857; }
.toml-value-integer { color: #b45309; }
.toml-value-float { color: #b45309; }
.toml-value-boolean { color: #be123c; }
.toml-value-datetime-offset,
.toml-value-datetime-local,
.toml-value-date-local,
.toml-value-time-local { color: #6d28d9; }
.toml-value-array,
.toml-value-inline-table {
    color: #475569;
}
.toml-children {
    margin-left: 16px;
    padding-left: 8px;
    border-left: 1px dashed #e2e8f0;
}
.toml-raw {
    margin: 0;
    padding: 12px 16px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12.5px;
    color: #0f172a;
    background: #ffffff;
    white-space: pre;
    overflow: auto;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
}
.toml-raw-token-key { color: #1d4ed8; font-weight: 600; }
.toml-raw-token-string { color: #047857; }
.toml-raw-token-number { color: #b45309; }
.toml-raw-token-boolean { color: #be123c; }
.toml-raw-token-null { color: #64748b; font-style: italic; }
.toml-raw-token-comment { color: #94a3b8; font-style: italic; }
.toml-raw-token-punctuation { color: #64748b; }
.toml-raw-token-value { color: #6d28d9; }
.toml-error {
    margin: 16px;
    padding: 12px 14px;
    border: 1px solid #fca5a5;
    background: #fef2f2;
    color: #b91c1c;
    border-radius: 4px;
    font-size: 12.5px;
}
.toml-loading {
    padding: 16px;
    color: #64748b;
}
.toml-search-hit > .toml-node-row {
    background: #fef3c7;
}
.toml-viewer-host{overflow:auto;background:#fff;color:#1f2328}.toml-container{height:auto;min-height:100%;padding:18px;gap:14px;box-sizing:border-box}.toml-header{align-items:flex-start;padding:0;border:0;background:transparent}.toml-title{font-size:16px;color:#1f2328}.toml-file-info{color:#656d76}.toml-path-bar,.toml-panel-header{display:flex;align-items:center;gap:10px}.toml-path-bar{padding:10px 12px;border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa}.toml-path-label{color:#656d76;font-size:12px}.toml-current-path{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.toml-toolbar{padding:0;border:0;background:transparent;flex-wrap:wrap}.toml-search{padding:7px 10px;border-color:#d0d7de;border-radius:6px}.toml-button{padding:7px 10px;border-color:#d0d7de;border-radius:6px;background:#eff2f5;color:#24292f}.toml-button.is-active{border-color:#0969da;background:#ddf4ff;color:#1f2328}
.toml-workspace{display:grid;grid-template-columns:minmax(320px,1fr) minmax(320px,1fr);gap:14px;min-height:66vh}.toml-panel{display:flex;flex-direction:column;min-height:0;border:1px solid #d0d7de;border-radius:8px;overflow:hidden;background:#fff}.toml-panel-header{justify-content:space-between;padding:12px 14px;border-bottom:1px solid #d0d7de;background:#f6f8fa}.toml-panel-header span:last-child{color:#656d76;font-size:12px}.toml-body,.toml-raw{flex:1;min-height:0}.toml-copy-json{margin-left:auto}.toml-tree{color:#1f2328}.toml-node-row.is-clickable:hover{background:#f6f8fa}
@media(max-width:760px){.toml-container{padding:12px}.toml-workspace{grid-template-columns:minmax(0,1fr)}}
`;

/**
 * Inject the runtime stylesheet into `document.head` exactly once. Subsequent
 * calls are no-ops. We tag the `<style>` element with a stable id so a hot
 * reload (or `dispose`+`render` of a different container) doesn't add a
 * duplicate copy.
 */
export function ensureTomlViewerStyles(): void {
    if (typeof document === 'undefined') return;
    const id = 'toml-viewer-runtime-styles';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = TOML_VIEWER_RUNTIME_CSS;
    document.head.appendChild(style);
}
