// Pure helpers for the video viewer.
//
// This module is the Chrome-side port of the formatting/derivation helpers
// embedded inline inside `vscode-omni-viewer/src/templates/videoViewer.html`.
// In the VSCode original those were `formatTime`, the file-info derivation,
// and the `{{fileSize}}` template substitution — all jumbled together with
// the imperative DOM code.
//
// We extract the pure pieces so they can be unit-tested under jest+jsdom
// without touching the DOM. The orchestration layer (`videoViewerMain.ts`)
// imports these and binds them to the DOM.
//
// VSCode -> Chrome notes:
//   - `acquireVsCodeApi()` / `vscode.postMessage` are gone; logging is just
//     `console`. This module never logs.
//   - `{{fileName}}` / `{{fileSize}}` template substitution was done by
//     `templateUtils.replaceTemplateVariables` on the VSCode side. The
//     Chrome runtime obtains those values from the live `File` object,
//     so we offer `formatFileSize` and `getVideoFormatFromFile` instead.

/**
 * Format a time in seconds.
 *
 * - Below 1h: `m:ss` (e.g. 65 -> `1:05`).
 * - At/above 1h: `h:mm:ss` (e.g. 3600 -> `1:00:00`, 3661 -> `1:01:01`).
 *
 * Issue #30 extended the original VSCode behavior (which always used
 * `m:ss`) so long videos display a sensible hours segment instead of
 * spilling minutes past 60. Returns `0:00` for non-finite / negative
 * inputs so the time display is always a stable string.
 */
export function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const totalSecs = Math.floor(seconds);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hours > 0) {
        return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format a byte count as a human-readable size string (e.g. `1.4 MB`).
 * Same convention as `imageUtils.formatFileSize`: base-1024, one decimal
 * past the byte unit, `--` for invalid input.
 */
export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '--';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    const value = bytes / Math.pow(k, i);
    const formatted = i === 0 ? value.toFixed(0) : value.toFixed(1);
    return `${formatted} ${units[i]}`;
}

/**
 * Format a resolution as `<width>×<height>` using the Unicode multiplication
 * sign, or `--` when either dimension is missing/invalid. Mirrors the inline
 * VSCode logic at videoViewer.html line 626-628.
 */
export function formatResolution(width: number, height: number): string {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return '--';
    if (width <= 0 || height <= 0) return '--';
    return `${Math.round(width)}×${Math.round(height)}`;
}

/**
 * Derive a display format string from a `File`. Prefers the explicit MIME
 * subtype (`video/mp4` -> `MP4`); falls back to the upper-cased file
 * extension when the MIME type is missing or generic. Same shape as
 * `imageUtils.getImageFormatFromFile` so the UX is consistent across
 * viewers.
 */
export function getVideoFormatFromFile(file: { name: string; type?: string }): string {
    const type = (file.type || '').toLowerCase();
    if (type.startsWith('video/')) {
        const sub = type.slice('video/'.length).split(';')[0].trim();
        if (sub && sub !== 'unknown') {
            const cleaned = sub.replace(/^x-/, '');
            return cleaned.toUpperCase();
        }
    }
    const dot = file.name.lastIndexOf('.');
    if (dot === -1 || dot === file.name.length - 1) {
        return '';
    }
    return file.name.slice(dot + 1).toUpperCase();
}

/**
 * Clamp a 0..1 fraction. Used by the progress-bar seek math so an
 * out-of-bounds drag doesn't push `video.currentTime` outside `[0, duration]`.
 */
export function clampFraction(fraction: number): number {
    if (!Number.isFinite(fraction)) return 0;
    if (fraction < 0) return 0;
    if (fraction > 1) return 1;
    return fraction;
}

/**
 * Compute the time corresponding to a 0..1 progress-bar fraction. Returns 0
 * when `duration` is non-finite or non-positive (initial state before the
 * `loadedmetadata` event fires).
 */
export function fractionToTime(fraction: number, duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return clampFraction(fraction) * duration;
}

/**
 * Compute the 0..1 progress fraction from a current time + duration. Returns
 * 0 when `duration` is non-finite or non-positive. Useful for both the
 * progress-bar fill width and (later, #29) loop-region rendering.
 */
export function timeToFraction(currentTime: number, duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    if (!Number.isFinite(currentTime) || currentTime < 0) return 0;
    return clampFraction(currentTime / duration);
}

// --- Issue #29 helpers ---------------------------------------------------
//
// The `<select id="playbackSpeed">` ladder, the ±10s skip button clamp, and
// the loop-region restart predicate are extracted as pure functions so the
// tests in `src/__tests__/videoLoopRegion.test.ts` can cover them without
// touching the DOM.

/**
 * Ordered playback-rate ladder offered by the speed `<select>`. The default
 * playback rate is `1` (index 3). Values mirror the dropdown options in the
 * VSCode reference (`#playbackSpeed`).
 */
export const PLAYBACK_SPEEDS: readonly number[] = [
    0.25,
    0.5,
    0.75,
    1,
    1.25,
    1.5,
    2,
    4
] as const;

/** Default playback rate when the viewer mounts. */
export const DEFAULT_PLAYBACK_SPEED = 1;

/**
 * Step through the `PLAYBACK_SPEEDS` ladder. `direction` is `+1` (faster) or
 * `-1` (slower); any other value is treated as 0 (no change). When the
 * current speed is not on the ladder, we snap to the nearest neighbor first
 * and then step from there. Saturates at the ladder edges (does not wrap).
 *
 * Not currently wired to a UI button — the dropdown picks a value directly —
 * but exposed (and tested) so future keyboard shortcuts can reuse it.
 */
export function nextSpeed(current: number, direction: number): number {
    const ladder = PLAYBACK_SPEEDS;
    if (!Number.isFinite(current)) return DEFAULT_PLAYBACK_SPEED;

    // Find the closest ladder index for `current`.
    let nearest = 0;
    let nearestDelta = Math.abs(ladder[0] - current);
    for (let i = 1; i < ladder.length; i++) {
        const d = Math.abs(ladder[i] - current);
        if (d < nearestDelta) {
            nearest = i;
            nearestDelta = d;
        }
    }

    if (direction > 0) {
        return ladder[Math.min(ladder.length - 1, nearest + 1)];
    }
    if (direction < 0) {
        return ladder[Math.max(0, nearest - 1)];
    }
    return ladder[nearest];
}

/**
 * Clamp a time value into `[0, duration]`. Used by the ±10s skip buttons so
 * we never push `video.currentTime` past the playable range. Falls back to
 * `0` when `duration` is non-finite (metadata not yet loaded) so seeking
 * before metadata simply seeks to the start.
 */
export function clampTime(t: number, duration: number): number {
    if (!Number.isFinite(t)) return 0;
    if (t < 0) return 0;
    if (!Number.isFinite(duration) || duration <= 0) {
        // Without a known duration we can only clamp the lower bound.
        return Math.max(0, t);
    }
    if (t > duration) return duration;
    return t;
}

/**
 * Predicate for the loop-region timeupdate handler.
 *
 * Returns `true` when both `a` and `b` markers are set, `b > a`, and the
 * current playback time has reached or passed `b`. The orchestration layer
 * uses this to decide whether to jump `currentTime` back to `a`.
 *
 * Markers may be `undefined` (Set A / Set B not yet pressed, or cleared).
 * If only one marker is set, or `b <= a`, looping is disabled.
 */
export function loopShouldRestart(
    currentTime: number,
    a: number | undefined,
    b: number | undefined
): boolean {
    if (a === undefined || b === undefined) return false;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (!Number.isFinite(currentTime)) return false;
    if (b <= a) return false;
    return currentTime >= b;
}

// --- Issue #30 zoom helpers ---------------------------------------------
//
// The video viewer offers a discrete zoom ladder identical in shape to the
// PDF / Word / image zoom ladders so the UX is consistent across viewers.
// These helpers are pure (no DOM) so the orchestration layer can apply the
// percentage as a CSS `transform: scale()` and the unit tests in
// `src/__tests__/videoZoom.test.ts` can exercise the math without jsdom.

/**
 * Ordered zoom-percent ladder. Mirrors `pdf/js/pdfZoom.ts` so user habits
 * carry across viewers. `100` is the natural "no zoom" level.
 */
export const ZOOM_LEVELS_PERCENT: readonly number[] = [
    50, 75, 100, 125, 150, 200, 300
] as const;

/** Default zoom percent when the viewer mounts. */
export const DEFAULT_ZOOM_PERCENT = 100;

/**
 * Snap an arbitrary percent to the nearest ladder index. Off-ladder values
 * (e.g. 110% from a fit-to-screen computation) collapse to the closest
 * level so a subsequent `nextZoom`/`prevZoom` step makes intuitive
 * progress. Saturates at the ends.
 */
export function nearestZoomIndex(percent: number): number {
    const ladder = ZOOM_LEVELS_PERCENT;
    if (!Number.isFinite(percent)) return ladder.indexOf(DEFAULT_ZOOM_PERCENT);
    if (percent <= ladder[0]) return 0;
    if (percent >= ladder[ladder.length - 1]) return ladder.length - 1;
    let bestIdx = 0;
    let bestDelta = Math.abs(ladder[0] - percent);
    for (let i = 1; i < ladder.length; i++) {
        const d = Math.abs(ladder[i] - percent);
        if (d < bestDelta) {
            bestIdx = i;
            bestDelta = d;
        }
    }
    return bestIdx;
}

/**
 * Step up the zoom ladder. Off-ladder values snap to the nearest level
 * first, then advance one step. Saturates at 300%.
 */
export function nextZoom(current: number): number {
    const idx = nearestZoomIndex(current);
    return ZOOM_LEVELS_PERCENT[Math.min(ZOOM_LEVELS_PERCENT.length - 1, idx + 1)];
}

/**
 * Step down the zoom ladder. Mirror of `nextZoom`. Saturates at 50%.
 */
export function prevZoom(current: number): number {
    const idx = nearestZoomIndex(current);
    return ZOOM_LEVELS_PERCENT[Math.max(0, idx - 1)];
}

/** True iff there is a higher level on the ladder than `current`. */
export function canZoomIn(current: number): boolean {
    return nearestZoomIndex(current) < ZOOM_LEVELS_PERCENT.length - 1;
}

/** True iff there is a lower level on the ladder than `current`. */
export function canZoomOut(current: number): boolean {
    return nearestZoomIndex(current) > 0;
}

/**
 * Render a zoom percent as `<rounded>%`. Off-ladder fit values are rounded
 * to the nearest integer so the toolbar label stays compact.
 */
export function formatZoomLabel(percent: number): string {
    if (!Number.isFinite(percent)) return `${DEFAULT_ZOOM_PERCENT}%`;
    return `${Math.round(percent)}%`;
}

/** Convert a zoom percent into a CSS scale multiplier (e.g. 125 -> 1.25). */
export function percentToScale(percent: number): number {
    if (!Number.isFinite(percent) || percent <= 0) return 1;
    return percent / 100;
}

// --- Issue #32 helpers ---------------------------------------------------
//
// The Chrome <video> element only natively decodes a handful of containers /
// codecs. When the user opens an `.avi`/`.wmv`/`.flv`/`.mts`/`.m2ts`/`.mkv`
// (or any other file we successfully route to the video viewer) and Chrome
// can't decode it, we surface a friendly panel + Download button instead of
// the bare native error. The message text is centralised here so the wording
// can be unit-tested without spinning up jsdom + the full mount path.

/**
 * Extract the file extension (including the leading dot) from `fileName`.
 * Returns the empty string when there is no extension. Case-preserving.
 *
 * Mirrored from `src/utils/fileUtils/media.ts#extOf` so the video viewer
 * doesn't have to import the larger module just for this helper.
 */
export function extOfFileName(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    if (dot < 0 || dot === fileName.length - 1) return '';
    return fileName.slice(dot);
}

/**
 * Build the message shown in the unsupported-codec fallback panel.
 *
 * Issue #32 wording (translated): "{ext} files use a codec your browser
 * doesn't decode natively. You can download the file or open it in a media
 * player." When the file has no extension (rare in practice — the router
 * never reaches this code path without one) we fall back to a generic
 * "This video" phrasing so the panel is still grammatical.
 */
export function buildUnsupportedCodecMessage(fileName: string): string {
    const ext = extOfFileName(fileName);
    const subject = ext ? `${ext.slice(1).toUpperCase()} files` : 'This video';
    const verb = ext ? 'use' : 'uses';
    return (
        `${subject} ${verb} a codec your browser doesn't decode natively. ` +
        'You can download the file or open it in a media player.'
    );
}

/**
 * Compute the fit-to-screen percent for a video of `videoWidth × videoHeight`
 * intrinsic dimensions inside a `containerWidth × containerHeight` box.
 *
 * Fit means: the largest scale that keeps both dimensions within the
 * container. Returns the result clamped to `[ZOOM_LEVELS_PERCENT[0],
 * ZOOM_LEVELS_PERCENT[last]]` so the label never exceeds the ladder bounds
 * (the actual transform can still produce sub-50% if the container is tiny;
 * the clamp here is purely cosmetic for the label).
 *
 * Returns `100` (the default) when any input is invalid or non-positive,
 * which matches the natural pre-metadata state.
 */
export function computeFitZoomPercent(
    videoWidth: number,
    videoHeight: number,
    containerWidth: number,
    containerHeight: number
): number {
    if (
        !Number.isFinite(videoWidth) ||
        !Number.isFinite(videoHeight) ||
        !Number.isFinite(containerWidth) ||
        !Number.isFinite(containerHeight)
    ) {
        return DEFAULT_ZOOM_PERCENT;
    }
    if (videoWidth <= 0 || videoHeight <= 0) return DEFAULT_ZOOM_PERCENT;
    if (containerWidth <= 0 || containerHeight <= 0) return DEFAULT_ZOOM_PERCENT;
    const scale = Math.min(
        containerWidth / videoWidth,
        containerHeight / videoHeight
    );
    const percent = scale * 100;
    const lo = ZOOM_LEVELS_PERCENT[0];
    const hi = ZOOM_LEVELS_PERCENT[ZOOM_LEVELS_PERCENT.length - 1];
    if (percent < lo) return lo;
    if (percent > hi) return hi;
    return percent;
}
