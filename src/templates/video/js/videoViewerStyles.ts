// Inline copy of `src/templates/video/css/videoViewer.css` so the bundled JS
// module can self-inject styles when the router mounts the viewer into the
// legacy SPA's host page.
//
// Same rationale as `imageViewerStyles.ts`: the router mounts viewers into
// the SPA host, which does NOT load `templates/video/css/videoViewer.css`.
// Bundling the CSS into the JS module avoids editing webpack config (which
// is forbidden by the issue guardrails) and avoids fighting the legacy SPA
// stylesheet ordering.
//
// The companion `.css` file is kept as the human-readable reference and as
// the stylesheet referenced by the per-viewer manual debug shell
// (`templates/video/videoViewer.html`). Keep both in sync.

export const VIDEO_VIEWER_CSS = `
.vv-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px;
    box-sizing: border-box;
    color: #e8e8e8;
    gap: 12px;
}
.vv-main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
}
.vv-file-info {
    display: flex;
    align-items: center;
    gap: 18px;
    font-size: 12px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.08);
}
.vv-file-info-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
}
.vv-file-info-label {
    font-size: 10px;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.vv-file-info-value {
    font-family: 'Monaco', 'Menlo', monospace;
    font-weight: 500;
}
.vv-controls {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    flex-wrap: wrap;
}
.vv-control-group {
    display: flex;
    align-items: center;
    gap: 5px;
}
.vv-btn {
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.15s ease;
    line-height: 1.2;
    min-width: 36px;
}
.vv-btn:hover { background: #3a3a3a; }
.vv-btn:active { background: #444; }
.vv-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.vv-time-display {
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 12px;
    color: #e8e8e8;
    min-width: 48px;
    text-align: center;
}
.vv-progress-container {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 6px;
    min-width: 200px;
}
.vv-progress-bar-wrapper {
    flex: 1;
    height: 8px;
    background: rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    cursor: pointer;
    position: relative;
}
.vv-progress-bar-wrapper:hover { height: 10px; }
.vv-progress-bar-wrapper:hover .vv-progress-bar-handle { opacity: 1; }
.vv-progress-bar-wrapper.dragging .vv-progress-bar-handle { opacity: 1; }
.vv-progress-bar-filled {
    height: 100%;
    background: #4a90e2;
    border-radius: 4px;
    pointer-events: none;
    position: relative;
    width: 0%;
}
.vv-progress-bar-handle {
    width: 12px;
    height: 12px;
    background: #ffffff;
    border: 2px solid #4a90e2;
    border-radius: 50%;
    position: absolute;
    right: -6px;
    top: 50%;
    transform: translateY(-50%);
    opacity: 0;
    transition: opacity 0.15s;
    pointer-events: none;
}
.vv-volume-control {
    display: flex;
    align-items: center;
    gap: 6px;
}
.vv-volume-slider {
    width: 80px;
    accent-color: #4a90e2;
}
.vv-video-container {
    flex: 1;
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 12px;
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 0;
    box-sizing: border-box;
    overflow: hidden;
}
.vv-video-wrapper {
    position: relative;
    max-width: 100%;
    max-height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
}
.vv-video-wrapper > video {
    max-width: 100%;
    max-height: 100%;
    border-radius: 4px;
    background: #000;
    display: block;
}
.vv-loading {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
    width: 100%;
    font-size: 14px;
    opacity: 0.7;
    color: #e8e8e8;
}
.vv-error {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
    width: 100%;
    color: #f48771;
    text-align: center;
    padding: 20px;
}

/* #32 Unsupported-codec fallback panel. The <video> error handler makes
 * the parent .vv-error visible (display: flex) and we render a vertical
 * stack with a friendly explanation + a Download button so the user can
 * still get the bytes even if Chrome refuses to decode them. */
.vv-error-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    max-width: 480px;
}
.vv-error-message {
    color: #e8e8e8;
    font-size: 13px;
    line-height: 1.5;
    opacity: 0.9;
}
.vv-error-download {
    text-decoration: none;
    display: inline-block;
    background: #4a90e2;
    color: #ffffff;
    border-color: rgba(255, 255, 255, 0.16);
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 500;
}
.vv-error-download:hover { background: #5fa1ee; }
.vv-error-download:active { background: #3a78c2; }

/* #29 playback-speed dropdown. Sized to match the existing .vv-btn so the
 * speed picker visually matches the rest of the toolbar.
 */
.vv-speed-select {
    background: #2c2c2c;
    color: #e8e8e8;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 5px 8px;
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.2;
    cursor: pointer;
}
.vv-speed-select:hover { background: #3a3a3a; }

/* #29 loop-region markers. Pure-CSS positioning: \`left: %\` is set by the
 * orchestration layer based on \`timeToFraction(time, duration)\`. Markers are
 * thin vertical bars overlaid on the progress bar; they do NOT capture
 * pointer events so the seek-on-click behavior keeps working underneath.
 */
.vv-loop-marker {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 2px;
    pointer-events: none;
    z-index: 2;
    transform: translateX(-1px);
}
.vv-loop-marker.a { background: #50c878; }
.vv-loop-marker.b { background: #f48771; }

/* #30 zoom controls. Same shape as the PDF / Word zoom toolbar so the UX
 * is consistent across viewers. The buttons inherit \`.vv-btn\` styling and
 * the \`.vv-zoom-btn\` class is reserved for future per-viewer overrides
 * (icon-only state, hover affordance, etc.) without disturbing the shared
 * button look.
 */
.vv-zoom-controls {
    display: flex;
    align-items: center;
    gap: 5px;
}
.vv-zoom-btn {
    min-width: 32px;
    padding: 6px 10px;
}
.vv-zoom-label {
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 12px;
    color: #e8e8e8;
    min-width: 44px;
    text-align: center;
    user-select: none;
}
`;
