export const AUTOMOTIVE_VIEWER_CSS = `
.automotive-viewer-host {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: clamp(640px, 78vh, 980px);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #172033;
    background: #f7f9fc;
}
.automotive-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    background: #ffffff;
}
.automotive-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid #dce3ee;
}
.automotive-title {
    min-width: 0;
    font-size: 13px;
    font-weight: 700;
    color: #111827;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.automotive-subtitle {
    margin-top: 3px;
    font-size: 11px;
    color: #617089;
}
.automotive-kind {
    border: 1px solid #adc0d8;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 700;
    color: #24476f;
    background: #edf4fb;
}
.automotive-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 1px;
    background: #dce3ee;
    border-bottom: 1px solid #dce3ee;
}
.automotive-stat {
    background: #f8fafc;
    padding: 9px 12px;
}
.automotive-stat-label {
    display: block;
    font-size: 10px;
    color: #64748b;
    text-transform: uppercase;
}
.automotive-stat-value {
    display: block;
    margin-top: 3px;
    font-size: 14px;
    font-weight: 700;
    color: #0f172a;
}
.automotive-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid #e2e8f0;
    background: #f8fafc;
}
.automotive-search {
    flex: 1;
    min-width: 0;
    padding: 7px 9px;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    font-size: 12px;
    background: #ffffff;
    color: #0f172a;
}
.automotive-mode {
    padding: 7px 10px;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    background: #ffffff;
    color: #172033;
    font-size: 12px;
    cursor: pointer;
}
.automotive-mode.is-active {
    background: #176b87;
    border-color: #176b87;
    color: #ffffff;
}
.automotive-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
}
.automotive-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
    padding: 14px;
}
.automotive-section {
    min-width: 0;
    border: 1px solid #dce3ee;
    border-radius: 6px;
    background: #ffffff;
}
.automotive-section-title {
    padding: 9px 10px;
    border-bottom: 1px solid #e5edf6;
    font-size: 12px;
    font-weight: 700;
    color: #1f2937;
}
.automotive-list {
    margin: 0;
    padding: 8px 10px;
    list-style: none;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.55;
}
.automotive-list li {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.automotive-empty {
    padding: 12px;
    color: #64748b;
    font-size: 12px;
}
.automotive-raw,
.automotive-hex {
    box-sizing: border-box;
    margin: 0;
    min-height: 100%;
    padding: 12px 14px;
    overflow: auto;
    white-space: pre;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
    color: #111827;
    background: #ffffff;
}
.automotive-highlight {
    background: #fff3b0;
}
.automotive-app,.dbc-shell{display:flex;flex-direction:column;min-height:100%;height:100%}.automotive-topbar,.dbc-header{display:flex;justify-content:space-between;align-items:flex-start;padding:14px 16px 10px;border-bottom:1px solid #dce3ee;background:#f8fafc}.automotive-eyebrow{color:#64748b;font-size:11px;text-transform:uppercase}.automotive-topbar h1{margin:2px 0 3px;font-size:18px}.automotive-table-toolbar,.dbc-toolbar{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #dce3ee;background:#f8fafc}.automotive-table-toolbar input,.dbc-toolbar input,.dbc-toolbar select{min-width:180px;padding:7px 9px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;color:#172033}.automotive-table-toolbar input{width:min(320px,36vw)}.automotive-table-toolbar button,.automotive-tabs button,.dbc-toolbar button,.dbc-tabs button{padding:7px 10px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;color:#172033;cursor:pointer}.automotive-tabs{display:flex;flex:1;flex-wrap:wrap;gap:4px}.automotive-tabs button.is-active,.dbc-tabs button.is-active{background:#176b87;border-color:#176b87;color:#fff}.automotive-summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:#dce3ee;border-bottom:1px solid #dce3ee}.automotive-summary-item{min-height:58px;padding:10px 13px;background:#fff}.automotive-summary-value{font-size:19px;font-weight:700}.automotive-summary-label{margin-top:3px;color:#64748b;font-size:11px}.automotive-warning-panel,.dbc-warnings{padding:10px 14px;border-bottom:1px solid #e4b64f;background:#fff8db;color:#725400}.automotive-content{min-height:0;flex:1;overflow:hidden}.automotive-table-panel,.automotive-raw-panel{height:100%;overflow:auto}.automotive-panel-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;padding:9px 13px;border-bottom:1px solid #dce3ee;background:#fff}.automotive-panel-header h2{margin:0;font-size:14px}.automotive-panel-header span{color:#64748b;font-size:11px}.automotive-table-wrap{overflow:auto}.automotive-table-wrap table,.dbc-table-wrap table{width:100%;border-collapse:collapse}.automotive-table-wrap th,.automotive-table-wrap td,.dbc-table-wrap th,.dbc-table-wrap td{padding:7px 9px;border-bottom:1px solid #e2e8f0;text-align:left;white-space:nowrap}.automotive-table-wrap th,.dbc-table-wrap th{position:sticky;top:42px;background:#f8fafc}.automotive-table-wrap td{max-width:520px;overflow:hidden;text-overflow:ellipsis}.automotive-raw-panel pre{box-sizing:border-box;min-height:100%;margin:0;padding:14px;white-space:pre-wrap}.automotive-error{margin:20px;padding:14px;border:1px solid #f4a6a6;border-radius:6px;background:#fff4f4;color:#a41515}
.dbc-shell{padding:14px;box-sizing:border-box;gap:10px;background:#f7f9fc}.dbc-header,.dbc-summary,.dbc-toolbar,.dbc-message-panel,.dbc-detail-panel,.dbc-warnings{border:1px solid #dce3ee;border-radius:7px;background:#fff}.dbc-title{font-size:16px;font-weight:700}.dbc-subtitle{margin-top:3px;color:#64748b;font-size:11px}.dbc-status{padding:6px 9px;border-radius:6px;background:#edf4fb;color:#24476f;font-size:11px;font-weight:700}.dbc-status.is-warning{background:#fff8db;color:#725400}.dbc-summary{display:flex;flex-wrap:wrap;gap:20px;padding:9px 12px}.dbc-summary div{display:flex;flex-direction:column;gap:2px}.dbc-summary span{color:#64748b;font-size:10px;text-transform:uppercase}.dbc-summary strong{font-size:14px}.dbc-toolbar{border-radius:7px}.dbc-toolbar .dbc-search{flex:1}.dbc-toolbar label{display:flex;align-items:center;gap:6px;color:#64748b;font-size:11px}.dbc-workspace{display:grid;grid-template-columns:minmax(280px,.72fr) minmax(540px,1.28fr);gap:10px;flex:1;min-height:0}.dbc-message-panel,.dbc-detail-panel{display:flex;flex-direction:column;min-height:0;overflow:hidden}.dbc-panel-header,.dbc-detail-header{display:flex;justify-content:space-between;align-items:flex-start;padding:10px 12px;border-bottom:1px solid #dce3ee;background:#f8fafc}.dbc-message-caption,.dbc-detail-subtitle{color:#64748b;font-size:11px}.dbc-message-list{overflow:auto;padding:7px}.dbc-message-row{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;margin-bottom:5px;padding:8px;border:1px solid transparent;border-radius:6px;background:transparent;text-align:left;color:#172033;cursor:pointer}.dbc-message-row:hover{background:#f1f5f9}.dbc-message-row.is-selected{border-color:#176b87;background:#e8f3f7}.dbc-message-name{overflow:hidden;text-overflow:ellipsis;font-weight:700}.dbc-message-extra{grid-column:1/-1;color:#64748b;font-size:11px}.dbc-detail-title{font-size:17px;font-weight:700}.dbc-message-meta{display:flex;flex-wrap:wrap}.dbc-tabs{display:flex;gap:5px;padding:9px 11px 0}.dbc-signals-tab{display:flex;flex-direction:column;min-height:0;flex:1}.dbc-table-wrap{min-height:0;overflow:auto;padding:9px 11px 0}.dbc-table-wrap th{top:0}.dbc-table-wrap tbody tr{cursor:pointer}.dbc-table-wrap tbody tr:hover{background:#f1f5f9}.dbc-table-wrap tbody tr.is-selected{background:#e8f3f7}.dbc-comment,.dbc-signal-detail,.dbc-nodes{margin:9px 11px 0;padding:9px;border:1px solid #dce3ee;border-radius:6px;background:#f8fafc}.dbc-signal-detail{margin-bottom:11px;max-height:170px;overflow:auto}.dbc-source{flex:1;min-height:0;margin:9px 11px 11px;padding:11px;resize:none;border:1px solid #dce3ee;border-radius:6px;background:#fff;color:#172033;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.dbc-nodes{flex:1;overflow:auto;margin-bottom:11px}.dbc-chip{display:inline-block;margin:0 5px 5px 0;padding:3px 6px;border:1px solid #cbd5e1;border-radius:5px;background:#eef2f7;font-size:11px}.is-hidden{display:none!important}@media(max-width:900px){.dbc-workspace{grid-template-columns:1fr}.dbc-message-panel{max-height:300px}}@media(max-width:720px){.automotive-table-toolbar,.dbc-toolbar{align-items:stretch;flex-direction:column}.automotive-table-toolbar input,.dbc-toolbar input,.dbc-toolbar select{width:100%;box-sizing:border-box}}

/* Give data-heavy automotive formats the full viewport and a stable table area. */
body:has(.automotive-viewer-host) .app {
    width: 100%;
    max-width: none;
}
body:has(.automotive-viewer-host) .viewer-body {
    padding: 0;
}
.automotive-eyebrow.automotive-kind {
    display: inline-flex;
    width: auto;
    padding: 4px 8px;
}
.automotive-topbar h1 {
    margin-top: 6px;
}
.automotive-summary-item {
    min-height: 72px;
    padding: 12px 16px;
}
.automotive-table-toolbar input {
    width: clamp(260px, 32vw, 520px);
}
.automotive-content {
    display: flex;
    flex: 1;
    min-height: 420px;
    overflow: hidden;
}
.automotive-table-panel,
.automotive-raw-panel {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: auto;
    overflow: hidden;
}
.automotive-panel-header {
    position: static;
    flex: 0 0 auto;
    padding: 11px 16px;
}
.automotive-table-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
}
.automotive-table-wrap th {
    top: 0;
    z-index: 1;
}
.automotive-table-wrap th,
.automotive-table-wrap td {
    padding: 9px 14px;
}
.automotive-table-wrap td {
    max-width: 720px;
}
.automotive-raw-panel {
    overflow: auto;
}
@media (max-width: 720px) {
    .automotive-viewer-host { min-height: 720px; }
    .automotive-tabs { width: 100%; }
}
`;

export function ensureAutomotiveViewerStyles(): void {
    if (typeof document === 'undefined') return;
    const id = 'automotive-viewer-runtime-styles';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = AUTOMOTIVE_VIEWER_CSS;
    document.head.appendChild(style);
}
