// Save flow for the image viewer (issue #15).
//
// Chrome-side port of
// `vscode-omni-viewer/src/templates/image/js/imageSave.js`. The VSCode
// original posted base64 data back to the extension host (`vscode.postMessage`)
// for it to write into the workspace. The Chrome extension has no host
// bridge, so we composite onto a `<canvas>`, convert to a Blob, and either
//
//   - hand the Blob to `window.showSaveFilePicker()` (File System Access API,
//     available in Chromium-based browsers), OR
//   - fall back to a synthetic `<a download>` click when the picker isn't
//     available.
//
// This module is split into:
//
//   - PURE helpers exported for tests (`defaultEditedFilename`,
//     `mimeFromExtension`, `extensionFromMime`, `naturalScaleForCanvas`,
//     `computeNaturalCoords`) — no DOM globals, no async I/O.
//   - DOM-aware helpers (`renderImageToCanvas`, `composeEditedImage`,
//     `saveBlob`) used by `imageViewerMain` to drive the actual save.
//
// The pure helpers cover the math the compositor does so a reasonable test
// can verify element-on-image positioning without spinning up a full canvas.

import type { ElementData } from './ImageEditMode/managers/ElementManager';

/**
 * Mapping from lowercased extension (no leading dot) to canonical
 * `image/<sub>` MIME type. Mirrors the formats `<canvas>.toBlob` actually
 * supports across Chromium browsers.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp'
});

/**
 * Reverse mapping from canonical MIME to the extension we want to suggest in
 * the save dialog. Note: `image/jpeg` -> `jpg` (the more common form).
 */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp'
});

/** Extensions we recognise as raster images. Used by `mimeFromExtension`. */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(MIME_BY_EXTENSION));

/**
 * Given the original file name (e.g. `photo.jpg`), return the default
 * filename suggested in the Save dialog: `<basename>-edited.png`.
 *
 * Behaviour:
 *   - Strips the LAST extension only — `archive.tar.gz` -> `archive.tar`.
 *   - Falls back to `image-edited.png` for empty / extension-less names.
 *   - Always returns a `.png` filename: the compositor outputs PNG so the
 *     suggested filename matches the actual blob MIME.
 */
export function defaultEditedFilename(originalName: string): string {
    if (typeof originalName !== 'string') {
        return 'image-edited.png';
    }
    const trimmed = originalName.trim();
    if (trimmed === '') {
        return 'image-edited.png';
    }
    // Strip any directory prefix — File.name should never include one in the
    // browser, but accept "/path/to/foo.png" defensively for tests.
    const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    const baseName = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
    if (baseName === '') {
        return 'image-edited.png';
    }
    const dot = baseName.lastIndexOf('.');
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    if (stem === '') {
        return 'image-edited.png';
    }
    return `${stem}-edited.png`;
}

/**
 * Look up the MIME type for a filename's extension. Unknown extensions and
 * names without an extension default to `image/png` so the saved blob never
 * silently becomes `application/octet-stream`.
 */
export function mimeFromExtension(filename: string): string {
    if (typeof filename !== 'string') return 'image/png';
    const dot = filename.lastIndexOf('.');
    if (dot === -1 || dot === filename.length - 1) return 'image/png';
    const ext = filename.slice(dot + 1).toLowerCase();
    return MIME_BY_EXTENSION[ext] ?? 'image/png';
}

/** Inverse of `mimeFromExtension`: pick a sensible extension for a MIME. */
export function extensionFromMime(mime: string): string {
    if (typeof mime !== 'string') return 'png';
    return EXTENSION_BY_MIME[mime.toLowerCase()] ?? 'png';
}

/** Whether `filename` has one of the recognised raster image extensions. */
export function isKnownImageExtension(filename: string): boolean {
    if (typeof filename !== 'string') return false;
    const dot = filename.lastIndexOf('.');
    if (dot === -1 || dot === filename.length - 1) return false;
    return KNOWN_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
}

/**
 * Compute the per-axis scale that maps canvas-local px (the coordinate
 * system ElementManager stores in `ElementData.x/y/w/h`) onto the natural
 * image px (the coordinate system the saved canvas uses).
 *
 * When the displayed canvas size matches the image's natural size, both
 * scales are 1. When the image is fit-to-screen (smaller than natural), we
 * scale UP so elements drawn at canvas-local coordinates land at the right
 * spot in the saved blob.
 *
 * Defensive against zero / negative inputs — returns 1 in degenerate cases
 * so the compositor still produces a legible image instead of crashing.
 */
export interface NaturalScale {
    sx: number;
    sy: number;
}
export function naturalScaleForCanvas(
    canvasWidth: number,
    canvasHeight: number,
    naturalWidth: number,
    naturalHeight: number
): NaturalScale {
    const sx = canvasWidth > 0 && naturalWidth > 0 ? naturalWidth / canvasWidth : 1;
    const sy = canvasHeight > 0 && naturalHeight > 0 ? naturalHeight / canvasHeight : 1;
    return {
        sx: Number.isFinite(sx) && sx > 0 ? sx : 1,
        sy: Number.isFinite(sy) && sy > 0 ? sy : 1
    };
}

/**
 * Map an element's canvas-local geometry onto the natural-image coordinate
 * system. ElementManager stores `(x, y)` as the *center* of every element
 * (the DOM nodes use `transform: translate(-50%, -50%)`), so the same
 * convention applies here.
 *
 * Returns:
 *   - `cx, cy` — natural-image center of the element
 *   - `w, h` — natural-image bounding-box size
 *   - `fontSize` — scaled font size for text elements; pass-through `0`
 *     for shapes (callers branch on element type anyway).
 */
export interface NaturalElementCoords {
    cx: number;
    cy: number;
    w: number;
    h: number;
    fontSize: number;
}
export function computeNaturalCoords(
    el: Pick<ElementData, 'x' | 'y' | 'w' | 'h' | 'type' | 'style'>,
    scale: NaturalScale
): NaturalElementCoords {
    const cx = el.x * scale.sx;
    const cy = el.y * scale.sy;
    const w = Math.max(0, el.w * scale.sx);
    const h = Math.max(0, el.h * scale.sy);
    let fontSize = 0;
    if (el.type === 'text') {
        const raw = (el.style && typeof el.style.fontSize === 'number') ? el.style.fontSize : 24;
        // Use the larger axis scale so text stays legible under non-uniform
        // aspect ratios (very rare — fit-to-screen is uniform — but better
        // than silently shrinking).
        fontSize = raw * Math.max(scale.sx, scale.sy);
    }
    return { cx, cy, w, h, fontSize };
}

/**
 * Draw a single edit element onto the supplied canvas context using the
 * natural-image coordinate system. Pure with respect to its inputs (the
 * canvas mutation is contained), so the function can be unit-tested with a
 * mock context.
 *
 * IMPORTANT: callers must clear `ctx.filter` to `'none'` before invoking
 * this, otherwise the underlying CSS filter would also colorize/desaturate
 * the overlay shapes (text would inherit grayscale, etc). The composite
 * routine in `composeEditedImage` does that.
 */
export function drawElementOnCanvas(
    ctx: CanvasRenderingContext2D,
    el: ElementData,
    scale: NaturalScale
): void {
    const coords = computeNaturalCoords(el, scale);
    const opacity = clamp01(el.style.opacity ?? 1);

    ctx.save();
    ctx.globalAlpha = opacity;

    if (el.type === 'text') {
        const text = el.text ?? '';
        const fill = el.style.fill ?? '#ff3030';
        // Family matches the .iv-edit-text CSS rule (-apple-system stack).
        ctx.font = `${coords.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.fillStyle = fill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, coords.cx, coords.cy);
    } else if (el.type === 'rect') {
        const fill = el.style.fill ?? '#ff3030';
        const stroke = el.style.stroke ?? '#000000';
        const strokeWidth = (el.style.strokeWidth ?? 2) * Math.max(scale.sx, scale.sy);
        const x = coords.cx - coords.w / 2;
        const y = coords.cy - coords.h / 2;
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, coords.w, coords.h);
        if (strokeWidth > 0) {
            ctx.lineWidth = strokeWidth;
            ctx.strokeStyle = stroke;
            ctx.strokeRect(x, y, coords.w, coords.h);
        }
    } else if (el.type === 'circle') {
        const fill = el.style.fill ?? '#ff3030';
        const stroke = el.style.stroke ?? '#000000';
        const strokeWidth = (el.style.strokeWidth ?? 2) * Math.max(scale.sx, scale.sy);
        // SVG <circle> uses the smaller-axis radius minus stroke half so the
        // shape stays inside the bounding box. Mirror that here.
        const r = Math.max(0, Math.min(coords.w, coords.h) / 2 - strokeWidth / 2);
        ctx.beginPath();
        ctx.arc(coords.cx, coords.cy, r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        if (strokeWidth > 0) {
            ctx.lineWidth = strokeWidth;
            ctx.strokeStyle = stroke;
            ctx.stroke();
        }
    }

    ctx.restore();
}

function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 1;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
}

// --- DOM-aware composite + save flow -----------------------------------

/**
 * Inputs for {@link composeEditedImage}. The compositor needs:
 *   - the original `<img>` (drawn at natural size);
 *   - the canvas-local rect of the edit canvas (so element coordinates can
 *     be mapped to natural-image px);
 *   - the CSS filter string that's currently applied to the on-screen image;
 *   - the elements to draw on top.
 */
export interface ComposeOptions {
    image: HTMLImageElement;
    editCanvasWidth: number;
    editCanvasHeight: number;
    filterString: string;
    elements: readonly ElementData[];
}

/**
 * Render the original image + filter + edit elements onto a fresh
 * `HTMLCanvasElement` sized to the image's natural dimensions. Returns the
 * canvas; callers can `toBlob()` it to obtain a saveable blob.
 *
 * Two passes:
 *   1. `ctx.filter = filterString` -> drawImage at natural size. This
 *      bakes brightness/contrast/saturate/grayscale into the pixels.
 *   2. `ctx.filter = 'none'` -> draw each element via
 *      `drawElementOnCanvas`. Filters do NOT apply to the overlay so the
 *      caller's color picks survive.
 */
export function composeEditedImage(opts: ComposeOptions): HTMLCanvasElement {
    const { image, editCanvasWidth, editCanvasHeight, filterString, elements } = opts;
    const naturalW = image.naturalWidth || image.width || 1;
    const naturalH = image.naturalHeight || image.height || 1;

    const canvas = document.createElement('canvas');
    canvas.width = naturalW;
    canvas.height = naturalH;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
        ctx = canvas.getContext('2d');
    } catch {
        // jsdom throws "Not implemented" without the optional `canvas`
        // dependency. Fall through and return the bare canvas.
        ctx = null;
    }
    if (!ctx) {
        // jsdom etc — return the empty canvas so callers don't crash. The
        // resulting blob will be a blank PNG, which the test harness still
        // exercises through the save flow.
        return canvas;
    }

    // Pass 1: baseline image with filter baked in.
    try {
        ctx.filter = filterString || 'none';
    } catch {
        // Older Chrome / jsdom may throw on assignment — fall back silently.
    }
    ctx.drawImage(image, 0, 0, naturalW, naturalH);

    // Pass 2: overlay elements, no filter.
    try {
        ctx.filter = 'none';
    } catch {
        /* noop */
    }
    const scale = naturalScaleForCanvas(editCanvasWidth, editCanvasHeight, naturalW, naturalH);
    for (const el of elements) {
        drawElementOnCanvas(ctx, el, scale);
    }

    return canvas;
}

/** A minimal subset of the File System Access API we rely on. */
interface FileSystemWritableFileStreamLike {
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
}
interface FileSystemFileHandleLike {
    createWritable(): Promise<FileSystemWritableFileStreamLike>;
}
interface ShowSaveFilePickerOptions {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}
type ShowSaveFilePickerFn = (options?: ShowSaveFilePickerOptions) => Promise<FileSystemFileHandleLike>;

/**
 * Save `blob` to disk under `filename`. Prefers `showSaveFilePicker` (gives
 * the user a real Save-As dialog with overwrite confirmation); falls back to
 * the classic anchor-download trick when the picker is not available or the
 * user denies access.
 *
 * Returns:
 *   - `'saved'`  — file was written via the picker
 *   - `'downloaded'` — fell back to the anchor trick (browser-managed download)
 *   - `'cancelled'` — user cancelled the picker (no fallback attempted)
 */
export type SaveBlobResult = 'saved' | 'downloaded' | 'cancelled';

export async function saveBlob(
    blob: Blob,
    filename: string,
    options: { preferPicker?: boolean } = {}
): Promise<SaveBlobResult> {
    const preferPicker = options.preferPicker ?? true;
    const mime = blob.type || mimeFromExtension(filename);

    const picker = preferPicker
        ? (globalThis as unknown as { showSaveFilePicker?: ShowSaveFilePickerFn }).showSaveFilePicker
        : undefined;

    if (typeof picker === 'function') {
        try {
            const handle = await picker({
                suggestedName: filename,
                types: [
                    {
                        description: 'Image',
                        accept: { [mime]: [`.${extensionFromMime(mime)}`] }
                    }
                ]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return 'saved';
        } catch (err) {
            // AbortError = user cancelled. Anything else, fall back.
            if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
                return 'cancelled';
            }
            // Fall through to anchor-download.
        }
    }

    downloadBlobViaAnchor(blob, filename);
    return 'downloaded';
}

/** Trigger a synthetic anchor-download for `blob` under `filename`. */
function downloadBlobViaAnchor(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    // Firefox needs the anchor in the DOM for click() to take effect.
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    try {
        anchor.click();
    } finally {
        document.body.removeChild(anchor);
        // Defer revoke so the browser has time to start the download.
        setTimeout(() => {
            try {
                URL.revokeObjectURL(url);
            } catch {
                /* noop */
            }
        }, 0);
    }
}

/**
 * `canvas.toBlob` returns the blob through a callback; promisify it so the
 * save flow can `await` cleanly. Resolves to `null` when encoding fails.
 */
export function canvasToBlob(canvas: HTMLCanvasElement, mime = 'image/png'): Promise<Blob | null> {
    return new Promise((resolve) => {
        try {
            // jsdom exposes toBlob but always returns null — the await chain
            // tolerates that branch, see saveBlob() callers in main.
            canvas.toBlob((blob) => resolve(blob), mime);
        } catch {
            resolve(null);
        }
    });
}
