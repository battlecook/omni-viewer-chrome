export const PLANTUML_VIEWER_CSS = `
.plantuml-viewer-host{height:100%;min-height:0;overflow:auto;background:#fff;color:#1f2328;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--pu-border:#d0d7de;--pu-muted:#656d76;--pu-panel:#f6f8fa;--pu-button:#eff2f5;--pu-focus:#0969da}
.plantuml-shell{min-height:100%;box-sizing:border-box;padding:18px;display:flex;flex-direction:column;gap:14px}
.plantuml-header,.plantuml-toolbar,.plantuml-toolbar-group,.plantuml-panel-header,.plantuml-select-field{display:flex;align-items:center;gap:10px}.plantuml-header{align-items:flex-start;justify-content:space-between;gap:16px}.plantuml-title{font-size:16px;font-weight:600;margin-bottom:4px;word-break:break-word}.plantuml-file-info,.plantuml-panel-header span:last-child,.plantuml-select-field span{color:var(--pu-muted);font-size:12px}
.plantuml-status{padding:7px 10px;border-radius:999px;border:1px solid var(--pu-border);background:#ddf4ff;color:#0550ae;font-size:12px;font-weight:600;white-space:nowrap}.plantuml-status.is-valid{background:#dafbe1;color:#1a7f37}.plantuml-status.is-invalid{background:#ffebe9;color:#cf222e}
.plantuml-toolbar{flex-wrap:wrap}.plantuml-toolbar-group{flex-wrap:wrap;padding:7px;border:1px solid var(--pu-border);border-radius:8px;background:var(--pu-panel)}
.plantuml-button,.plantuml-select{border:1px solid var(--pu-border);background:var(--pu-button);color:#24292f;border-radius:6px;padding:7px 10px;font:inherit}.plantuml-button{min-width:36px;cursor:pointer}.plantuml-button:hover{background:#e7ebef}.plantuml-button.is-active{border-color:var(--pu-focus);background:#ddf4ff}.plantuml-button.is-primary{background:#0969da;color:#fff;border-color:#0969da}.plantuml-button.is-primary:hover{background:#0860ca}.plantuml-button.is-dirty{border-color:#9a6700;color:#9a6700}.plantuml-zoom-label{width:auto;text-align:center}
.plantuml-workspace{display:grid;grid-template-columns:minmax(360px,1fr);gap:14px;flex:1;min-height:66vh}.plantuml-workspace[data-mode="split"]{grid-template-columns:minmax(320px,1.3fr) minmax(300px,.7fr)}.plantuml-workspace[data-mode="split"] .plantuml-source-panel{grid-column:2}.plantuml-workspace[data-mode="source"] .plantuml-diagram-panel,.plantuml-workspace[data-mode="diagram"] .plantuml-source-panel{display:none}
.plantuml-panel{display:flex;flex-direction:column;min-height:0;border:1px solid var(--pu-border);border-radius:8px;background:#fff;overflow:hidden}.plantuml-panel-header{justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--pu-border);background:var(--pu-panel)}
.plantuml-canvas{flex:1;min-height:0;overflow:auto;padding:20px}.plantuml-diagram{min-width:100%;min-height:100%;display:flex;align-items:flex-start;justify-content:center;transform-origin:top center}.plantuml-diagram svg{max-width:none;height:auto;background:#fff}
.plantuml-source{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;border:0;outline:0;padding:16px;background:transparent;color:#1f2328;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:2}
.plantuml-message{border:1px solid #cf222e;border-radius:8px;padding:12px 14px;color:#cf222e;background:#ffebe9;white-space:pre-wrap}
@media(max-width:760px){.plantuml-shell{padding:12px}.plantuml-header{flex-wrap:wrap}.plantuml-workspace,.plantuml-workspace[data-mode="split"]{grid-template-columns:minmax(0,1fr)}.plantuml-workspace[data-mode="split"] .plantuml-source-panel{grid-column:1}}
`;

export function ensurePlantUmlViewerStyles(): void {
    if (typeof document === 'undefined') return;
    const id = 'plantuml-viewer-runtime-styles';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = PLANTUML_VIEWER_CSS;
    document.head.appendChild(style);
}
