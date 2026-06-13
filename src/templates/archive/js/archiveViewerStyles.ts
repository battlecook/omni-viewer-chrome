// Inline copy of `src/templates/archive/css/archiveViewer.css` so the bundled
// JS module can self-inject styles when the router mounts the viewer into
// the legacy SPA's host page (which does not load the per-viewer CSS).
//
// Keep this file in sync with `archiveViewer.css` — both are intentionally
// duplicated so the manual debug shell (`archiveViewer.html`) and the
// runtime injection both have the same visual rules.

export const ARCHIVE_VIEWER_CSS = `
.av-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px;
    box-sizing: border-box;
    color: #e8e8e8;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
.av-header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 8px;
    flex-wrap: wrap;
}
.av-title {
    font-size: 14px;
    font-weight: 600;
    color: #f0f0f0;
}
.av-pill {
    background: #2a2a2a;
    color: #ccc;
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 11px;
}
.av-status {
    margin: 8px 0;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    color: #ccc;
    background: #2a2a2a;
}
.av-status.is-error {
    background: #4a1f1f;
    color: #ffb4b4;
}
.av-status.is-warn {
    background: #4a3a1f;
    color: #ffd58a;
}
.av-status[hidden] { display: none; }
.av-body {
    display: grid;
    grid-template-columns: minmax(220px, 360px) 1fr;
    gap: 12px;
    flex: 1;
    min-height: 0;
}
.av-list-pane,
.av-preview-pane {
    background: #1c1c1c;
    border: 1px solid #333;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
}
.av-list-header,
.av-preview-header {
    padding: 8px 10px;
    background: #232323;
    border-bottom: 1px solid #333;
    font-size: 12px;
    color: #ccc;
    display: flex;
    align-items: center;
    gap: 8px;
}
.av-list-search {
    flex: 1;
    background: #1a1a1a;
    color: #eee;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
}
.av-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
}
.av-list-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    border-bottom: 1px solid #262626;
    color: #ddd;
}
.av-list-item:hover {
    background: #262626;
}
.av-list-item.is-selected {
    background: #2f3a4f;
    color: #fff;
}
.av-list-item.is-directory {
    color: #9ad;
    cursor: default;
}
.av-list-item-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.av-list-item-size {
    font-variant-numeric: tabular-nums;
    color: #999;
    font-size: 11px;
}
.av-empty {
    padding: 12px;
    color: #999;
    font-size: 12px;
}
.av-preview-meta {
    padding: 6px 10px;
    font-size: 11px;
    color: #999;
    border-bottom: 1px solid #262626;
    background: #1f1f1f;
}
.av-preview-content {
    flex: 1;
    overflow: auto;
    padding: 10px;
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
    font-size: 12px;
    color: #ddd;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
}
.av-preview-content.is-hex {
    white-space: pre;
    word-break: normal;
}
.av-preview-content[hidden] { display: none; }
.av-preview-media {
    flex: 1;
    overflow: auto;
    padding: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
}
.av-preview-media[hidden] { display: none; }
.av-preview-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    image-rendering: auto;
}
.av-preview-audio {
    width: 100%;
    max-width: 480px;
}
.av-preview-video {
    max-width: 100%;
    max-height: 100%;
}
.av-preview-too-large {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    color: #ccc;
    font-size: 12px;
    text-align: center;
}
.av-preview-too-large p { margin: 0; }
.av-preview-download {
    background: #2f3a4f;
    color: #fff;
    border: 1px solid #3d4a63;
    border-radius: 4px;
    padding: 6px 14px;
    font-size: 12px;
    cursor: pointer;
}
.av-preview-download:hover { background: #3a4763; }
`;
