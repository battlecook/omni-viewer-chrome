// Pure helpers for the image viewer.
//
// This module is the Chrome-side port of
// `vscode-omni-viewer/src/templates/image/js/imageUtils.js`. The VSCode
// original carried a `class ImageUtils` with member helpers used both by
// the viewer (transforms) and by the save flow (filenames, hex<->rgba).
//
// In the Chrome port we only need:
//   - the transform state model (`ImageTransform`)
//   - pure functions to mutate that state and serialize it to a CSS
//     `transform` string
//   - a couple of file-info derivations (format from File, formatted file
//     size string)
//
// All functions here are pure (no DOM access, no globals) so they are
// easy to unit-test under jest+jsdom.
//
// VSCode -> Chrome notes:
//   - `acquireVsCodeApi()` / `vscode.postMessage` were used in the
//     original to log to the host. The Chrome page has no such bridge —
//     callers can use `console` directly. This module never logs.
//   - `{{fileName}}` / `{{fileSize}}` template substitution was done by
//     `templateUtils.replaceTemplateVariables` on the VSCode side. The
//     Chrome runtime obtains those values from the live `File` object,
//     so we offer `formatFileSize` and `getImageFormatFromFile` instead.
//
// `imageViewerMain.ts` (the orchestration layer) consumes these helpers.

/**
 * Image transform state. Mirrors the four named scalars the VSCode
 * `imageViewerMain.js` carried as module-level mutable state:
 *
 *   currentZoom        -> scale (as a 0..n multiplier, not 0..100 percent)
 *   currentRotation    -> rotateDeg
 *   isFlippedHorizontal -> scaleX (-1 when flipped, otherwise +1)
 *   isFlippedVertical   -> scaleY (-1 when flipped, otherwise +1)
 *
 * The renamings reflect what the values actually are in CSS terms. The
 * VSCode original kept a duplicate "zoom percent" + "scale" representation;
 * we collapse to a single `scale` here and let the UI layer convert if
 * percent is needed for display.
 */
export interface ImageTransform {
    rotateDeg: number;
    scaleX: 1 | -1;
    scaleY: 1 | -1;
    scale: number;
}

/** Default identity transform (no rotation, no flip, 100% zoom). */
export function createIdentityTransform(): ImageTransform {
    return {
        rotateDeg: 0,
        scaleX: 1,
        scaleY: 1,
        scale: 1
    };
}

/** Min/max zoom bounds. Mirrors the VSCode original (10% .. 500%). */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 5;
/** Step amount used by the +/- zoom buttons. 25% per click. */
export const ZOOM_STEP = 0.25;

/**
 * Rotate by 90° clockwise, wrapping to [0, 360). The VSCode original used
 * `(currentRotation + 90) % 360`, but `%` is not a true modulo for negative
 * inputs, so we normalize defensively for callers that pass a delta of -90.
 */
export function rotate(transform: ImageTransform, deltaDeg = 90): ImageTransform {
    const next = ((transform.rotateDeg + deltaDeg) % 360 + 360) % 360;
    return { ...transform, rotateDeg: next };
}

/** Flip across the horizontal axis (toggles `scaleY`). */
export function flipVertical(transform: ImageTransform): ImageTransform {
    return { ...transform, scaleY: (transform.scaleY === 1 ? -1 : 1) as 1 | -1 };
}

/** Flip across the vertical axis (toggles `scaleX`). */
export function flipHorizontal(transform: ImageTransform): ImageTransform {
    return { ...transform, scaleX: (transform.scaleX === 1 ? -1 : 1) as 1 | -1 };
}

/** Clamp `scale` to [ZOOM_MIN, ZOOM_MAX]. */
export function clampScale(scale: number): number {
    if (!Number.isFinite(scale)) return 1;
    if (scale < ZOOM_MIN) return ZOOM_MIN;
    if (scale > ZOOM_MAX) return ZOOM_MAX;
    return scale;
}

/** Zoom in by `ZOOM_STEP`, clamped. */
export function zoomIn(transform: ImageTransform, step = ZOOM_STEP): ImageTransform {
    return { ...transform, scale: clampScale(transform.scale + step) };
}

/** Zoom out by `ZOOM_STEP`, clamped. */
export function zoomOut(transform: ImageTransform, step = ZOOM_STEP): ImageTransform {
    return { ...transform, scale: clampScale(transform.scale - step) };
}

/** Set scale to an absolute value, clamped. */
export function setScale(transform: ImageTransform, scale: number): ImageTransform {
    return { ...transform, scale: clampScale(scale) };
}

/**
 * Compute the fit-to-screen scale. Mirrors the VSCode logic:
 *
 *   const containerWidth = container.clientWidth - padding;
 *   const containerHeight = container.clientHeight - padding;
 *   const scale = Math.min(containerWidth / originalWidth,
 *                          containerHeight / originalHeight,
 *                          1);
 *
 * The `1` cap means we never *enlarge* small images on fit — only shrink
 * to fit. Returns the `scale` only; callers compose it with the rest of
 * the transform.
 */
export function computeFitToScreenScale(
    containerWidth: number,
    containerHeight: number,
    naturalWidth: number,
    naturalHeight: number,
    options: { padding?: number; allowUpscale?: boolean } = {}
): number {
    const padding = options.padding ?? 40;
    const allowUpscale = options.allowUpscale ?? false;

    if (naturalWidth <= 0 || naturalHeight <= 0) {
        return 1;
    }

    const availW = Math.max(0, containerWidth - padding);
    const availH = Math.max(0, containerHeight - padding);
    const sx = availW / naturalWidth;
    const sy = availH / naturalHeight;
    const raw = Math.min(sx, sy);
    const cap = allowUpscale ? Number.POSITIVE_INFINITY : 1;
    return clampScale(Math.min(raw, cap));
}

/**
 * Serialize the transform to a CSS `transform` value.
 *
 * The order matches the VSCode original's serialization:
 *
 *   image.style.transform = `scale(${scale * flipH}, ${scale * flipV}) rotate(${rotation}deg)`;
 *
 * which combines the flip into the scale axes and applies rotation last.
 */
export function transformToCss(transform: ImageTransform): string {
    const sx = transform.scale * transform.scaleX;
    const sy = transform.scale * transform.scaleY;
    return `scale(${sx}, ${sy}) rotate(${transform.rotateDeg}deg)`;
}

/**
 * Derive a display format string from a `File`. Prefers the explicit MIME
 * type subtype (`image/png` -> `PNG`); falls back to the upper-cased file
 * extension when the MIME type is missing or generic. The VSCode original
 * always took the extension; the Chrome port uses MIME first because the
 * browser usually has a more authoritative answer.
 */
export function getImageFormatFromFile(file: { name: string; type?: string }): string {
    const type = (file.type || '').toLowerCase();
    if (type.startsWith('image/')) {
        const sub = type.slice('image/'.length).split(';')[0].trim();
        if (sub && sub !== 'unknown') {
            // Strip vendor prefixes like "x-png" -> "png" -> "PNG"
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
 * Format a byte count as a human-readable size string (e.g. "1.4 MB").
 * Uses base-1024 units to match the VSCode `templateUtils.formatFileSize`
 * convention.
 */
export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '--';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    const value = bytes / Math.pow(k, i);
    // Whole bytes: no decimals. Otherwise one decimal place.
    const formatted = i === 0 ? value.toFixed(0) : value.toFixed(1);
    return `${formatted} ${units[i]}`;
}
