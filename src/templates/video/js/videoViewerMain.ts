// Orchestration layer for the video viewer.
//
// Chrome-side port of the inline `<script>` block inside
// `vscode-omni-viewer/src/templates/videoViewer.html` (lines 365-639).
//
// Responsibilities:
//   - Build the viewer DOM (HTML template below).
//   - Bind events on the underlying `<video>` element to the custom controls
//     (play/pause/seek/volume/progress-bar) and to the file-info panel.
//   - Own the blob URL produced from the input `File` and revoke it on
//     `dispose`.
//
// VSCode -> Chrome substitutions:
//   - `acquireVsCodeApi()` / `vscode.postMessage` are dropped. Errors go to
//     `console.error`; there is no host bridge in a Chrome extension page.
//   - The video source previously came from `webview.asWebviewUri` plus a
//     base64 data URL; in the Chrome port the caller (router) hands us a
//     `File` and we use `URL.createObjectURL(file)` as the `<video>` `src`.
//   - File size + format come from the live `File` object instead of the
//     `{{fileSize}}` / `{{fileName}}` template substitutions.
//
// Issue #28 scope (basic player skeleton). Deferred to follow-ups:
//   - #29 Loop region selection (A/B markers).
//   - #30 Playback-speed control + ±10s skip buttons.
//   - #31 Zoom / fit-to-window for the <video> element.
//   - #32 Additional container extensions (MTS/M2TS/AVI/WMV/FLV/MKV) and
//        keyboard-shortcut overlay.
// The HTML below intentionally leaves anchors for those features (data
// attributes / TODO comments) but does not render their UI.

import {
    formatTime,
    formatFileSize,
    formatResolution,
    getVideoFormatFromFile,
    fractionToTime,
    timeToFraction,
    clampTime,
    loopShouldRestart,
    DEFAULT_PLAYBACK_SPEED,
    DEFAULT_ZOOM_PERCENT,
    nextZoom,
    prevZoom,
    canZoomIn,
    canZoomOut,
    formatZoomLabel,
    percentToScale,
    computeFitZoomPercent,
    buildUnsupportedCodecMessage
} from './videoUtils';
import {
    routeKeyboardEvent,
    applyShortcutAction
} from './videoKeyboard';
import { VIDEO_VIEWER_CSS } from './videoViewerStyles';

const STYLE_ELEMENT_ID = 'omni-viewer-video-styles';

/** Inject the viewer stylesheet once per document. Same pattern as image. */
function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = VIDEO_VIEWER_CSS;
    document.head.appendChild(style);
}

/**
 * Set of DOM nodes the orchestrator owns. Resolved once in `mountVideoViewer`.
 * IDs intentionally use a `vv-` prefix to avoid collision with the legacy SPA
 * (which still ships its own `#video` etc.).
 */
interface VideoViewerDom {
    root: HTMLElement;
    video: HTMLVideoElement;
    videoWrapper: HTMLElement;
    videoContainer: HTMLElement;
    loading: HTMLElement;
    error: HTMLElement;
    errorMessage: HTMLElement;
    errorDownload: HTMLAnchorElement;
    fileInfo: HTMLElement;
    durationInfo: HTMLElement;
    resolutionInfo: HTMLElement;
    formatInfo: HTMLElement;
    fileSizeInfo: HTMLElement;
    playPauseBtn: HTMLButtonElement;
    skipBackwardBtn: HTMLButtonElement;
    skipForwardBtn: HTMLButtonElement;
    progressBar: HTMLElement;
    progressFilled: HTMLElement;
    currentTimeDisplay: HTMLElement;
    totalTimeDisplay: HTMLElement;
    volumeSlider: HTMLInputElement;
    playbackSpeedSelect: HTMLSelectElement;
    setABtn: HTMLButtonElement;
    setBBtn: HTMLButtonElement;
    clearABBtn: HTMLButtonElement;
    loopMarkerA: HTMLElement;
    loopMarkerB: HTMLElement;
    zoomInBtn: HTMLButtonElement;
    zoomOutBtn: HTMLButtonElement;
    zoomFitBtn: HTMLButtonElement;
    zoomLabel: HTMLElement;
}

/** Public mount handle. Caller (router/provider) gets a `dispose()`. */
export interface VideoViewerHandle {
    dispose(): void;
}

const VIEWER_HTML = /* html */ `
<div class="vv-container" data-video-viewer-root>
    <div class="vv-main-content">
        <div class="vv-file-info" id="vv-fileInfo" style="display: none;">
            <div class="vv-file-info-item">
                <div class="vv-file-info-label">Duration</div>
                <div class="vv-file-info-value" id="vv-durationInfo">--</div>
            </div>
            <div class="vv-file-info-item">
                <div class="vv-file-info-label">Resolution</div>
                <div class="vv-file-info-value" id="vv-resolutionInfo">--</div>
            </div>
            <div class="vv-file-info-item">
                <div class="vv-file-info-label">Format</div>
                <div class="vv-file-info-value" id="vv-formatInfo">--</div>
            </div>
            <div class="vv-file-info-item">
                <div class="vv-file-info-label">File Size</div>
                <div class="vv-file-info-value" id="vv-fileSizeInfo">--</div>
            </div>
        </div>

        <!-- Custom controls. Native <video controls> is intentionally NOT
             used so the look matches the rest of the viewer family and so
             #29 (loop region + playback speed + skip ±10s) / #31 (zoom) can
             attach to a UI we own. -->
        <div class="vv-controls">
            <div class="vv-control-group">
                <button id="vv-skipBackward" class="vv-btn" type="button" title="Skip backward 10 seconds">−10s</button>
                <button id="vv-playPause" class="vv-btn" type="button" title="Play / Pause (Space)">▶</button>
                <button id="vv-skipForward" class="vv-btn" type="button" title="Skip forward 10 seconds">+10s</button>
            </div>
            <span class="vv-time-display" id="vv-currentTime">0:00</span>
            <div class="vv-progress-container">
                <div class="vv-progress-bar-wrapper" id="vv-progressBar">
                    <div class="vv-progress-bar-filled" id="vv-progressFilled">
                        <div class="vv-progress-bar-handle"></div>
                    </div>
                    <!-- Loop-region markers (#29). Hidden via display:none
                         until the user presses Set A / Set B. Positioned via
                         a CSS \`left: %\` set imperatively from the
                         orchestration layer. -->
                    <div id="vv-loopMarkerA" class="vv-loop-marker a" style="display: none;" title="Loop start (A)"></div>
                    <div id="vv-loopMarkerB" class="vv-loop-marker b" style="display: none;" title="Loop end (B)"></div>
                </div>
            </div>
            <span class="vv-time-display" id="vv-totalTime">0:00</span>
            <div class="vv-volume-control">
                <span class="vv-file-info-label">Vol</span>
                <input id="vv-volume" class="vv-volume-slider" type="range"
                       min="0" max="1" step="0.01" value="1"
                       aria-label="Volume">
            </div>
            <div class="vv-control-group">
                <span class="vv-file-info-label">Speed</span>
                <select id="vv-playbackSpeed" class="vv-speed-select" aria-label="Playback speed">
                    <option value="0.25">0.25x</option>
                    <option value="0.5">0.5x</option>
                    <option value="0.75">0.75x</option>
                    <option value="1" selected>1x</option>
                    <option value="1.25">1.25x</option>
                    <option value="1.5">1.5x</option>
                    <option value="2">2x</option>
                    <option value="4">4x</option>
                </select>
            </div>
            <div class="vv-control-group">
                <button id="vv-setA" class="vv-btn" type="button" title="Set loop start (A) at current time">Set A</button>
                <button id="vv-setB" class="vv-btn" type="button" title="Set loop end (B) at current time">Set B</button>
                <button id="vv-clearAB" class="vv-btn" type="button" title="Clear loop region">Clear A-B</button>
            </div>
            <!-- #30 zoom controls. The label sits between the +/- buttons
                 (matching the PDF / Word zoom toolbar shape) and the Fit
                 button computes a scale that keeps both axes inside the
                 video container box. -->
            <div class="vv-zoom-controls vv-control-group">
                <button id="vv-zoomOut" class="vv-zoom-btn vv-btn" type="button" title="Zoom out">−</button>
                <span id="vv-zoomLabel" class="vv-zoom-label">100%</span>
                <button id="vv-zoomIn" class="vv-zoom-btn vv-btn" type="button" title="Zoom in">+</button>
                <button id="vv-zoomFit" class="vv-zoom-btn vv-btn" type="button" title="Fit to window">Fit</button>
            </div>
        </div>

        <div class="vv-video-container" id="vv-videoContainer">
            <div id="vv-loading" class="vv-loading">Loading video…</div>
            <!-- #32 Unsupported-codec fallback panel. The <video> error
                 handler swaps the loader/wrapper for this panel and fills
                 the message + download href. The download button is a
                 plain <a download> so the browser performs the save
                 without us touching the disk; it points at the same blob
                 URL the <video> tried to play. -->
            <div id="vv-error" class="vv-error" style="display: none;" role="alert">
                <div class="vv-error-panel">
                    <div class="vv-error-message" id="vv-errorMessage"></div>
                    <a id="vv-errorDownload" class="vv-btn vv-error-download"
                       href="#" download role="button">Download</a>
                </div>
            </div>
            <div id="vv-videoWrapper" class="vv-video-wrapper" style="display: none;">
                <!-- No \`controls\` attribute: the <video> renders bare and
                     the custom controls above drive it. -->
                <video id="vv-video" preload="metadata" playsinline></video>
            </div>
        </div>
    </div>
</div>
`;

/**
 * Render the video viewer into `container` for the given `File`. Returns a
 * handle whose `dispose()` revokes the blob URL and removes the listeners.
 */
export function mountVideoViewer(file: File, container: HTMLElement): VideoViewerHandle {
    ensureStylesInjected();
    container.innerHTML = VIEWER_HTML;

    const dom = resolveDom(container);
    const blobUrl = URL.createObjectURL(file);

    let isDragging = false;

    // --- #29 loop region state -------------------------------------------
    // `loopA` / `loopB` are the two loop markers in seconds. They are
    // independent: setting B before A is allowed, but the timeupdate guard
    // only loops once both are set AND `b > a`. Clear resets both.
    let loopA: number | undefined;
    let loopB: number | undefined;

    // --- #30 zoom state --------------------------------------------------
    // Current zoom percent. Applied to the `<video>` element via CSS
    // `transform: scale()`. `100` = 1.0 (no zoom). The Fit button computes
    // a fresh percent that keeps the video inside its container.
    let zoomPercent: number = DEFAULT_ZOOM_PERCENT;

    // --- helpers ----------------------------------------------------------
    const updateProgressFill = (): void => {
        const fraction = timeToFraction(dom.video.currentTime, dom.video.duration);
        dom.progressFilled.style.width = `${fraction * 100}%`;
    };

    const seekFromClientX = (clientX: number): void => {
        const rect = dom.progressBar.getBoundingClientRect();
        if (rect.width <= 0) return;
        const fraction = (clientX - rect.left) / rect.width;
        const t = fractionToTime(fraction, dom.video.duration);
        dom.video.currentTime = t;
        // Update fill optimistically — the timeupdate event will reconfirm.
        const f = timeToFraction(t, dom.video.duration);
        dom.progressFilled.style.width = `${f * 100}%`;
    };

    const updateFileInfo = (): void => {
        dom.durationInfo.textContent = Number.isFinite(dom.video.duration)
            ? formatTime(dom.video.duration)
            : '--';
        dom.resolutionInfo.textContent = formatResolution(
            dom.video.videoWidth,
            dom.video.videoHeight
        );
        dom.formatInfo.textContent = getVideoFormatFromFile(file) || '--';
        dom.fileSizeInfo.textContent = formatFileSize(file.size);
    };

    // --- #29 loop region rendering ---------------------------------------
    const renderLoopMarker = (
        marker: HTMLElement,
        time: number | undefined
    ): void => {
        if (time === undefined) {
            marker.style.display = 'none';
            return;
        }
        const fraction = timeToFraction(time, dom.video.duration);
        marker.style.left = `${fraction * 100}%`;
        marker.style.display = 'block';
    };
    const renderLoopMarkers = (): void => {
        renderLoopMarker(dom.loopMarkerA, loopA);
        renderLoopMarker(dom.loopMarkerB, loopB);
    };

    // --- #30 zoom rendering ----------------------------------------------
    // The video element's natural sizing is `max-width/-height: 100%` (see
    // `videoViewerStyles.ts`), so we apply zoom as a `transform: scale()`.
    // Origin is `center center` so the video stays centered in its
    // container as the user zooms in/out.
    const applyZoom = (): void => {
        const scale = percentToScale(zoomPercent);
        dom.video.style.transformOrigin = 'center center';
        dom.video.style.transform = scale === 1 ? '' : `scale(${scale})`;
        dom.zoomLabel.textContent = formatZoomLabel(zoomPercent);
        dom.zoomInBtn.disabled = !canZoomIn(zoomPercent);
        dom.zoomOutBtn.disabled = !canZoomOut(zoomPercent);
    };

    // --- #32 unsupported-codec fallback ----------------------------------
    // When the <video> element raises `error` (or `play()` rejects with a
    // codec-related cause) we hide the player and reveal a friendly panel
    // with a Download button. The button points at the blob URL we already
    // built for `<video src>` plus a `download` attribute so the browser
    // saves the original bytes.
    const showCodecFallback = (): void => {
        dom.errorMessage.textContent = buildUnsupportedCodecMessage(file.name);
        dom.errorDownload.href = blobUrl;
        dom.errorDownload.setAttribute('download', file.name);
        dom.loading.style.display = 'none';
        dom.videoWrapper.style.display = 'none';
        dom.error.style.display = 'flex';
    };

    // --- listeners --------------------------------------------------------
    const onPlayPauseClick = (): void => {
        if (dom.video.paused || dom.video.ended) {
            void dom.video.play().catch((err) => {
                // Autoplay policies / unsupported codec — surface the
                // friendly fallback panel so the user can still download
                // the file even if Chrome refuses to decode.
                console.error('video play failed:', err);
                showCodecFallback();
            });
        } else {
            dom.video.pause();
        }
    };

    const onPlay = (): void => {
        dom.playPauseBtn.textContent = '❚❚';
        dom.playPauseBtn.title = 'Pause (Space)';
    };
    const onPause = (): void => {
        dom.playPauseBtn.textContent = '▶';
        dom.playPauseBtn.title = 'Play (Space)';
    };
    const onEnded = (): void => {
        dom.playPauseBtn.textContent = '▶';
        dom.playPauseBtn.title = 'Play (Space)';
    };

    const onTimeUpdate = (): void => {
        // #29 loop region: jump back to A when we cross B. The pure-helper
        // predicate keeps the runtime check out of this orchestration layer
        // so it can be unit-tested without a DOM.
        if (loopShouldRestart(dom.video.currentTime, loopA, loopB)) {
            // `loopA` is guaranteed defined when the predicate returns true.
            const a = loopA as number;
            // Clamp to [0, duration] just in case A was set near the end of
            // the video and the duration changed after the fact.
            dom.video.currentTime = clampTime(a, dom.video.duration);
        }
        if (!isDragging) {
            updateProgressFill();
        }
        dom.currentTimeDisplay.textContent = formatTime(dom.video.currentTime);
    };

    const onLoadedMetadata = (): void => {
        dom.loading.style.display = 'none';
        dom.videoWrapper.style.display = 'flex';
        dom.fileInfo.style.display = 'flex';
        dom.totalTimeDisplay.textContent = formatTime(dom.video.duration);
        updateFileInfo();
        updateProgressFill();
        // Markers may have been positioned with a stale duration before
        // metadata loaded; recompute their `left: %` now that we know the
        // real duration.
        renderLoopMarkers();
    };

    const onDurationChange = (): void => {
        dom.totalTimeDisplay.textContent = formatTime(dom.video.duration);
        updateFileInfo();
        renderLoopMarkers();
    };

    const onVolumeChange = (): void => {
        // Keep the slider in sync if some future feature mutates volume
        // programmatically (e.g. mute toggle in #30).
        const v = dom.video.muted ? 0 : dom.video.volume;
        if (Math.abs(parseFloat(dom.volumeSlider.value) - v) > 0.001) {
            dom.volumeSlider.value = String(v);
        }
    };

    const onVolumeSliderInput = (): void => {
        const v = parseFloat(dom.volumeSlider.value);
        if (!Number.isFinite(v)) return;
        dom.video.volume = Math.max(0, Math.min(1, v));
        // Implicit unmute when the user drags off zero.
        if (dom.video.muted && v > 0) {
            dom.video.muted = false;
        }
    };

    const onProgressMouseDown = (e: MouseEvent): void => {
        isDragging = true;
        dom.progressBar.classList.add('dragging');
        seekFromClientX(e.clientX);
    };
    const onDocumentMouseMove = (e: MouseEvent): void => {
        if (isDragging) {
            seekFromClientX(e.clientX);
        }
    };
    const onDocumentMouseUp = (): void => {
        if (isDragging) {
            isDragging = false;
            dom.progressBar.classList.remove('dragging');
        }
    };

    const onVideoError = (): void => {
        // The <video> element fires `error` for both unrecognised
        // containers and unsupported codecs (Chrome cannot natively decode
        // e.g. WMV9, MPEG-2 TS, or Matroska with HEVC). Either way we want
        // the same UX: hide the loader/wrapper and surface the
        // unsupported-codec panel with a download fallback.
        console.error('video element error', dom.video.error);
        showCodecFallback();
    };

    // --- #29 skip ±10s ---------------------------------------------------
    const SKIP_SECONDS = 10;
    const onSkipBackward = (): void => {
        dom.video.currentTime = clampTime(
            dom.video.currentTime - SKIP_SECONDS,
            dom.video.duration
        );
    };
    const onSkipForward = (): void => {
        dom.video.currentTime = clampTime(
            dom.video.currentTime + SKIP_SECONDS,
            dom.video.duration
        );
    };

    // --- #29 playback speed ----------------------------------------------
    const onPlaybackSpeedChange = (): void => {
        const v = parseFloat(dom.playbackSpeedSelect.value);
        if (!Number.isFinite(v) || v <= 0) return;
        dom.video.playbackRate = v;
    };

    // --- #29 loop region (Set A / Set B / Clear) -------------------------
    const onSetA = (): void => {
        loopA = dom.video.currentTime;
        renderLoopMarkers();
    };
    const onSetB = (): void => {
        loopB = dom.video.currentTime;
        renderLoopMarkers();
    };
    const onClearAB = (): void => {
        loopA = undefined;
        loopB = undefined;
        renderLoopMarkers();
    };

    // --- #30 zoom handlers ------------------------------------------------
    const onZoomIn = (): void => {
        const next = nextZoom(zoomPercent);
        if (next === zoomPercent) return;
        zoomPercent = next;
        applyZoom();
    };
    const onZoomOut = (): void => {
        const prev = prevZoom(zoomPercent);
        if (prev === zoomPercent) return;
        zoomPercent = prev;
        applyZoom();
    };
    // --- #31 keyboard shortcuts ------------------------------------------
    // Document-level listener so the shortcuts work as soon as the viewer is
    // mounted, regardless of which descendant has focus. The pure router in
    // `videoKeyboard.ts` decides whether the event is mapped + whether the
    // target is input-like; this layer just dispatches the result. We
    // `preventDefault` so e.g. Space doesn't also scroll the page.
    const onKeyDown = (e: KeyboardEvent): void => {
        const action = routeKeyboardEvent(e);
        if (!action) return;
        e.preventDefault();
        applyShortcutAction(action, dom.video);
    };

    const onZoomFit = (): void => {
        // Compute fit relative to the inner video container box. We use the
        // container client dims (already minus padding via getBoundingClientRect
        // inset) so fit accounts for the outer 12px padding. When metadata
        // hasn't loaded yet `videoWidth`/`videoHeight` are 0, in which case
        // `computeFitZoomPercent` returns the default 100%.
        const rect = dom.videoContainer.getBoundingClientRect();
        zoomPercent = computeFitZoomPercent(
            dom.video.videoWidth,
            dom.video.videoHeight,
            rect.width,
            rect.height
        );
        applyZoom();
    };

    // Wire up.
    dom.playPauseBtn.addEventListener('click', onPlayPauseClick);
    dom.skipBackwardBtn.addEventListener('click', onSkipBackward);
    dom.skipForwardBtn.addEventListener('click', onSkipForward);
    dom.playbackSpeedSelect.addEventListener('change', onPlaybackSpeedChange);
    dom.setABtn.addEventListener('click', onSetA);
    dom.setBBtn.addEventListener('click', onSetB);
    dom.clearABBtn.addEventListener('click', onClearAB);
    dom.zoomInBtn.addEventListener('click', onZoomIn);
    dom.zoomOutBtn.addEventListener('click', onZoomOut);
    dom.zoomFitBtn.addEventListener('click', onZoomFit);
    dom.video.addEventListener('play', onPlay);
    dom.video.addEventListener('pause', onPause);
    dom.video.addEventListener('ended', onEnded);
    dom.video.addEventListener('timeupdate', onTimeUpdate);
    dom.video.addEventListener('loadedmetadata', onLoadedMetadata);
    dom.video.addEventListener('durationchange', onDurationChange);
    dom.video.addEventListener('volumechange', onVolumeChange);
    dom.video.addEventListener('error', onVideoError);
    dom.volumeSlider.addEventListener('input', onVolumeSliderInput);
    dom.progressBar.addEventListener('mousedown', onProgressMouseDown);
    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('mouseup', onDocumentMouseUp);
    document.addEventListener('keydown', onKeyDown);

    // Initialize playback speed to the default and reflect it in the
    // dropdown. The dropdown's HTML `selected` attribute matches this value;
    // we set it explicitly so future default changes flow through one place.
    dom.video.playbackRate = DEFAULT_PLAYBACK_SPEED;
    dom.playbackSpeedSelect.value = String(DEFAULT_PLAYBACK_SPEED);

    // Initialize zoom to the default and render the label / button states.
    applyZoom();

    // Assign source last so all listeners are in place by the time
    // `loadedmetadata` fires. `playsinline` is set on the element itself
    // (no controls attribute — see the HTML template above).
    dom.video.src = blobUrl;
    // Initialize slider to the element's current volume (browsers may
    // restore a saved value).
    dom.volumeSlider.value = String(dom.video.volume);

    return {
        dispose(): void {
            try {
                dom.video.pause();
            } catch {
                // best-effort
            }
            dom.playPauseBtn.removeEventListener('click', onPlayPauseClick);
            dom.skipBackwardBtn.removeEventListener('click', onSkipBackward);
            dom.skipForwardBtn.removeEventListener('click', onSkipForward);
            dom.playbackSpeedSelect.removeEventListener('change', onPlaybackSpeedChange);
            dom.setABtn.removeEventListener('click', onSetA);
            dom.setBBtn.removeEventListener('click', onSetB);
            dom.clearABBtn.removeEventListener('click', onClearAB);
            dom.zoomInBtn.removeEventListener('click', onZoomIn);
            dom.zoomOutBtn.removeEventListener('click', onZoomOut);
            dom.zoomFitBtn.removeEventListener('click', onZoomFit);
            dom.video.removeEventListener('play', onPlay);
            dom.video.removeEventListener('pause', onPause);
            dom.video.removeEventListener('ended', onEnded);
            dom.video.removeEventListener('timeupdate', onTimeUpdate);
            dom.video.removeEventListener('loadedmetadata', onLoadedMetadata);
            dom.video.removeEventListener('durationchange', onDurationChange);
            dom.video.removeEventListener('volumechange', onVolumeChange);
            dom.video.removeEventListener('error', onVideoError);
            dom.volumeSlider.removeEventListener('input', onVolumeSliderInput);
            dom.progressBar.removeEventListener('mousedown', onProgressMouseDown);
            document.removeEventListener('mousemove', onDocumentMouseMove);
            document.removeEventListener('mouseup', onDocumentMouseUp);
            document.removeEventListener('keydown', onKeyDown);
            try {
                // Clearing src triggers a final unload so the blob is GC-able.
                dom.video.removeAttribute('src');
                dom.video.load();
            } catch {
                // best-effort
            }
            try {
                URL.revokeObjectURL(blobUrl);
            } catch {
                // best-effort
            }
        }
    };
}

/**
 * Throws when a required DOM node is missing — that would only happen if
 * the HTML template above drifts out of sync, so a hard error is the right
 * failure mode (the caller renders the unsupported fallback).
 */
function resolveDom(container: HTMLElement): VideoViewerDom {
    const need = <T extends HTMLElement>(id: string): T => {
        const el = container.querySelector<T>(`#${id}`);
        if (!el) {
            throw new Error(`video viewer: missing DOM node #${id}`);
        }
        return el;
    };
    const root = container.querySelector<HTMLElement>('[data-video-viewer-root]');
    if (!root) {
        throw new Error('video viewer: failed to mount root element');
    }
    return {
        root,
        video: need<HTMLVideoElement>('vv-video'),
        videoWrapper: need('vv-videoWrapper'),
        videoContainer: need('vv-videoContainer'),
        loading: need('vv-loading'),
        error: need('vv-error'),
        errorMessage: need('vv-errorMessage'),
        errorDownload: need<HTMLAnchorElement>('vv-errorDownload'),
        fileInfo: need('vv-fileInfo'),
        durationInfo: need('vv-durationInfo'),
        resolutionInfo: need('vv-resolutionInfo'),
        formatInfo: need('vv-formatInfo'),
        fileSizeInfo: need('vv-fileSizeInfo'),
        playPauseBtn: need<HTMLButtonElement>('vv-playPause'),
        skipBackwardBtn: need<HTMLButtonElement>('vv-skipBackward'),
        skipForwardBtn: need<HTMLButtonElement>('vv-skipForward'),
        progressBar: need('vv-progressBar'),
        progressFilled: need('vv-progressFilled'),
        currentTimeDisplay: need('vv-currentTime'),
        totalTimeDisplay: need('vv-totalTime'),
        volumeSlider: need<HTMLInputElement>('vv-volume'),
        playbackSpeedSelect: need<HTMLSelectElement>('vv-playbackSpeed'),
        setABtn: need<HTMLButtonElement>('vv-setA'),
        setBBtn: need<HTMLButtonElement>('vv-setB'),
        clearABBtn: need<HTMLButtonElement>('vv-clearAB'),
        loopMarkerA: need('vv-loopMarkerA'),
        loopMarkerB: need('vv-loopMarkerB'),
        zoomInBtn: need<HTMLButtonElement>('vv-zoomIn'),
        zoomOutBtn: need<HTMLButtonElement>('vv-zoomOut'),
        zoomFitBtn: need<HTMLButtonElement>('vv-zoomFit'),
        zoomLabel: need('vv-zoomLabel')
    };
}
