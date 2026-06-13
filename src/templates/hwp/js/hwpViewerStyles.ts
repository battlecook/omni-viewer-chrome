// Inline copy of `src/templates/hwp/css/hwpViewer.css`. The SPA host
// page injects this string as a `<style>` block when the viewer mounts
// inside it, so the legacy single-page shell can render HWP without
// loading a separate stylesheet (mirrors `pdfViewerStyles.ts` /
// `psdViewerStyles.ts`).
//
// Keep this string in sync with the .css file alongside it. The .css
// file is the stylesheet referenced by the per-viewer
// `hwpViewer.html` debug shell.
//
// Korean font fallback (DoD #4): the `font-family` stack on
// `.hv-page` and `.hv-page svg foreignObject` declares Noto Sans CJK
// KR / Malgun Gothic / Apple SD Gothic Neo before the system sans
// fallback so HWP text rendered through wasm-bindgen-emitted SVGs
// uses a Korean-capable face on every host platform.

export const HWP_VIEWER_CSS = `
.hv-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: #e8e8e8;
    background: #1e1e1e;
    font-family: 'Noto Sans CJK KR', 'Malgun Gothic', 'Apple SD Gothic Neo',
        -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-sizing: border-box;
}

.hv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    background: #2a2a2a;
    border-bottom: 1px solid #3a3a3a;
    flex: 0 0 auto;
}

.hv-title {
    font-size: 13px;
    font-weight: 500;
    color: #e8e8e8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-right: 12px;
}

.hv-meta {
    font-size: 12px;
    color: #a0a0a0;
    flex: 0 0 auto;
}

.hv-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: #2b2b2b;
}

.hv-body iframe {
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
    border: none;
    display: block;
}

.hv-page {
    background: #ffffff;
    color: #111111;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    max-width: 100%;
    font-family: 'Noto Sans CJK KR', 'Malgun Gothic', 'Apple SD Gothic Neo',
        sans-serif;
}

.hv-page svg {
    display: block;
    max-width: 100%;
    height: auto;
}

.hv-page svg foreignObject {
    font-family: 'Noto Sans CJK KR', 'Malgun Gothic', 'Apple SD Gothic Neo',
        sans-serif;
}

.hv-loading,
.hv-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px;
    gap: 8px;
    text-align: center;
}

.hv-loading {
    color: #a0a0a0;
    font-size: 14px;
}

.hv-error {
    color: #ff8080;
    font-size: 14px;
    background: #2b1f1f;
    border: 1px solid #5a2a2a;
    border-radius: 6px;
    margin: 24px;
}

.hv-error-title {
    font-size: 16px;
    font-weight: 600;
    color: #ffb0b0;
}

.hv-error-detail {
    font-size: 12px;
    color: #d0a0a0;
    word-break: break-word;
    max-width: 720px;
}
`;
