export const MERMAID_VIEWER_CSS = `
.mermaid-viewer-host{height:100%;min-height:0;overflow:auto;background:#fff;color:#1f2328;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mm-border:#d0d7de;--mm-muted:#656d76;--mm-panel:#f6f8fa;--mm-button:#eff2f5;--mm-focus:#0969da}
.mermaid-shell{min-height:100%;box-sizing:border-box;padding:18px;display:flex;flex-direction:column;gap:14px}
.mermaid-header,.mermaid-toolbar,.mermaid-toolbar-group,.mermaid-panel-header,.mermaid-select-field{display:flex;align-items:center;gap:10px}
.mermaid-header{align-items:flex-start;justify-content:space-between;gap:16px}.mermaid-title{font-size:16px;font-weight:600;margin-bottom:4px;word-break:break-word}.mermaid-file-info,.mermaid-panel-header span:last-child,.mermaid-select-field span{color:var(--mm-muted);font-size:12px}
.mermaid-status{padding:7px 10px;border-radius:999px;border:1px solid var(--mm-border);background:#ddf4ff;color:#0550ae;font-size:12px;font-weight:600;white-space:nowrap}.mermaid-status.is-valid{background:#dafbe1;color:#1a7f37}.mermaid-status.is-invalid{background:#ffebe9;color:#cf222e}
.mermaid-toolbar{flex-wrap:wrap}.mermaid-toolbar-group{flex-wrap:wrap;padding:7px;border:1px solid var(--mm-border);border-radius:8px;background:var(--mm-panel)}
.mermaid-button,.mermaid-select{border:1px solid var(--mm-border);background:var(--mm-button);color:#24292f;border-radius:6px;padding:7px 10px;font:inherit}.mermaid-button{min-width:36px;cursor:pointer}.mermaid-button:hover{background:#e7ebef}.mermaid-button.is-active{border-color:var(--mm-focus);background:#ddf4ff}.mermaid-button.is-primary{background:#0969da;color:#fff;border-color:#0969da}.mermaid-button.is-primary:hover{background:#0860ca}.mermaid-button.is-dirty{border-color:#9a6700;color:#9a6700}.mermaid-zoom-label{width:auto;text-align:center}
.mermaid-workspace{display:grid;grid-template-columns:minmax(360px,1fr);gap:14px;flex:1;min-height:66vh}.mermaid-workspace[data-mode="split"]{grid-template-columns:minmax(320px,1.3fr) minmax(300px,.7fr)}.mermaid-workspace[data-mode="split"] .mermaid-source-panel{grid-column:2}.mermaid-workspace[data-mode="source"] .mermaid-diagram-panel,.mermaid-workspace[data-mode="diagram"] .mermaid-source-panel{display:none}
.mermaid-panel{display:flex;flex-direction:column;min-height:0;border:1px solid var(--mm-border);border-radius:8px;background:#fff;overflow:hidden}.mermaid-panel-header{justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--mm-border);background:var(--mm-panel)}
.mermaid-canvas{flex:1;min-height:0;overflow:auto;padding:20px}.mermaid-diagram{min-width:100%;min-height:100%;display:flex;align-items:flex-start;justify-content:center;transform-origin:top center}.mermaid-diagram svg{max-width:none;height:auto;background:#fff}
.mermaid-source{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;border:0;outline:0;padding:16px;background:transparent;color:#1f2328;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:2}
.mermaid-message{border:1px solid #cf222e;border-radius:8px;padding:12px 14px;color:#cf222e;background:#ffebe9;white-space:pre-wrap}
@media(max-width:760px){.mermaid-shell{padding:12px}.mermaid-header{flex-wrap:wrap}.mermaid-workspace,.mermaid-workspace[data-mode="split"]{grid-template-columns:minmax(0,1fr)}.mermaid-workspace[data-mode="split"] .mermaid-source-panel{grid-column:1}}
`;

export function ensureMermaidViewerStyles(): void {
    if (typeof document === 'undefined') return;
    const id = 'mermaid-viewer-runtime-styles';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = MERMAID_VIEWER_CSS;
    document.head.appendChild(style);
}
