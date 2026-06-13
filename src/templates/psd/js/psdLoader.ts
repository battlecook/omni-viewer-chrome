// Lazy loader + parser for the ag-psd browser bundle.
//
// VSCode-side reference: `vscode-omni-viewer/src/psdViewerProvider.ts` and
// `templates/psd/js/psdViewer.js` ship the same library and call
// `agPsd.readPsd(buf, { useImageData: true })`. Here we lazy-load the
// vendor bundle via a `<script>` tag injection so the JS only hits the
// network when the user actually opens a PSD.
//
// Scope cuts (issue #50):
//   - Layer panel + per-layer visibility are issue #51 (NOT in scope here).
//   - View modal + checkerboard background are issue #52 (NOT in scope).
// We therefore parse with `skipLayerImageData: true` to keep memory tight;
// only the composite image is materialized.
//
// Memory gate: PSD files larger than 200 MB are rejected up-front. ag-psd
// fully decodes the document into JS heap + canvases, and on Chrome a
// single 200 MB+ PSD can easily push past the per-tab heap cap and crash
// the page. The DoD for #50 explicitly calls out "큰 PSD (200MB) 메모리
// 가드", so we refuse such files before allocating an ArrayBuffer.

/* eslint-disable @typescript-eslint/no-explicit-any */
// Justification: ag-psd is loaded dynamically from a vendored UMD bundle.
// No TypeScript declarations are bundled with the extension, so the
// public surface is typed as `any` at the boundary and narrowed at each
// call site below.

const AG_PSD_VENDOR_PATH = 'vendor/ag-psd.min.js';

/** Hard refusal threshold for PSDs (bytes). */
export const PSD_MEMORY_GATE_BYTES = 200 * 1024 * 1024;

/**
 * Pure helper: returns true iff a PSD of the given `byteSize` is allowed
 * past the memory gate. Exported so unit tests can pin the boundary.
 */
export function isPsdSizeAcceptable(byteSize: number): boolean {
    if (!Number.isFinite(byteSize) || byteSize < 0) {
        return false;
    }
    return byteSize <= PSD_MEMORY_GATE_BYTES;
}

/**
 * Build the user-visible message shown when a PSD is rejected by the
 * memory gate. Pure function so tests can assert the format.
 */
export function buildPsdSizeRejectionMessage(byteSize: number): string {
    const mb = byteSize / (1024 * 1024);
    const mbStr = mb >= 100 ? mb.toFixed(0) : mb.toFixed(1);
    const limitMb = PSD_MEMORY_GATE_BYTES / (1024 * 1024);
    return `This PSD is ${mbStr} MB. Files larger than ${limitMb} MB are not opened to avoid crashing the tab.`;
}

/**
 * PSD color mode codes, as per the Photoshop file format spec. Reused by
 * the metadata bar; exposed here so unit tests can pin the mapping.
 */
const COLOR_MODE_NAMES: Record<number, string> = {
    0: 'Bitmap',
    1: 'Grayscale',
    2: 'Indexed',
    3: 'RGB',
    4: 'CMYK',
    7: 'Multichannel',
    8: 'Duotone',
    9: 'Lab'
};

/**
 * Format a PSD color-mode integer (`Psd['colorMode']` from ag-psd) as a
 * human-readable label. Falls back to `Mode <n>` for unknown codes so the
 * UI stays informative even when ag-psd surfaces an exotic value.
 */
export function formatColorMode(code: number | undefined): string {
    if (code === undefined || code === null) return 'Unknown';
    if (!Number.isFinite(code)) return 'Unknown';
    return COLOR_MODE_NAMES[code] ?? `Mode ${code}`;
}

/**
 * Resolve a vendor file to a URL the page can load via `<script src>`.
 * Same pattern as `pdfRenderer.ts` (`resolveVendorUrl`): use
 * `chrome.runtime.getURL` when available, otherwise fall back to a
 * relative path so unit tests / file:// previews can still import.
 */
function resolveVendorUrl(relativePath: string): string {
    if (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.getURL === 'function'
    ) {
        try {
            return chrome.runtime.getURL(relativePath);
        } catch {
            // Outside extension origin — fall through.
        }
    }
    return relativePath;
}

/**
 * Subset of the ag-psd surface we depend on.
 */
export interface AgPsdLib {
    readPsd(
        buffer: ArrayBuffer | Uint8Array,
        options?: {
            skipLayerImageData?: boolean;
            skipCompositeImageData?: boolean;
            skipThumbnail?: boolean;
            useImageData?: boolean;
            useRawThumbnail?: boolean;
        }
    ): ParsedPsdRaw;
}

/**
 * The shape ag-psd returns from `readPsd`. We only declare the fields we
 * actually use here — ag-psd surfaces many more.
 */
export interface ParsedPsdRaw {
    width: number;
    height: number;
    channels?: number;
    bitsPerChannel?: number;
    colorMode?: number;
    /** Present when `useImageData: true` is set. */
    canvas?: HTMLCanvasElement;
    /** Present when `useImageData: true` is set on browsers without canvas decode. */
    imageData?: ImageData;
    /**
     * Top-level layer tree, populated when `skipLayerImageData` is NOT
     * set. Issue #51 (layer panel) consumes this.
     */
    children?: import('./psdLayers').RawAgPsdLayer[];
}

interface AgPsdGlobalWindow extends Window {
    agPsd?: AgPsdLib;
    /** ag-psd publishes itself as `agPsd` in browsers (see ag-psd README). */
    __OMNI_AG_PSD_READY__?: Promise<AgPsdLib>;
}

let agPsdLibPromise: Promise<AgPsdLib> | undefined;

/**
 * Inject a `<script>` tag pointing at the vendor bundle and resolve once
 * it loads. We deliberately do NOT use dynamic `import()` here because
 * the ag-psd browser bundle ships as a UMD that publishes `window.agPsd`
 * — an ESM dynamic import yields an empty default export.
 */
function injectAgPsdScript(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (typeof document === 'undefined') {
            reject(new Error('ag-psd: no document available to inject script tag'));
            return;
        }
        // Reuse an in-flight tag if another mount started loading first.
        const existing = document.querySelector<HTMLScriptElement>(
            'script[data-omni-ag-psd]'
        );
        if (existing) {
            if ((existing as HTMLScriptElement & { _loaded?: boolean })._loaded) {
                resolve();
                return;
            }
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () =>
                reject(new Error(`ag-psd: failed to load ${url}`))
            );
            return;
        }
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.dataset.omniAgPsd = '1';
        script.addEventListener('load', () => {
            (script as HTMLScriptElement & { _loaded?: boolean })._loaded = true;
            resolve();
        });
        script.addEventListener('error', () =>
            reject(new Error(`ag-psd: failed to load ${url}`))
        );
        document.head.appendChild(script);
    });
}

/**
 * Load the ag-psd library, caching the resulting promise so multiple PSD
 * mounts on the same page reuse the same script tag.
 *
 * If the vendor bundle is missing — which it is in the current Chrome
 * build, see the `vendor/` audit comment in the issue #50 PR — this
 * rejects with a descriptive error so the caller can render a friendly
 * notice instead of crashing.
 */
export async function loadAgPsdLib(): Promise<AgPsdLib> {
    if (agPsdLibPromise) {
        return agPsdLibPromise;
    }
    if (typeof window === 'undefined') {
        throw new Error('ag-psd: no window available to host the library');
    }
    const win = window as AgPsdGlobalWindow;
    if (win.__OMNI_AG_PSD_READY__) {
        agPsdLibPromise = win.__OMNI_AG_PSD_READY__;
        return agPsdLibPromise;
    }
    // If the page already exposes the lib (e.g. a future shell preloaded
    // it), use it directly.
    if (win.agPsd && typeof win.agPsd.readPsd === 'function') {
        agPsdLibPromise = Promise.resolve(win.agPsd);
        win.__OMNI_AG_PSD_READY__ = agPsdLibPromise;
        return agPsdLibPromise;
    }

    const url = resolveVendorUrl(AG_PSD_VENDOR_PATH);
    agPsdLibPromise = (async () => {
        await injectAgPsdScript(url);
        const lib = (window as AgPsdGlobalWindow).agPsd;
        if (!lib || typeof lib.readPsd !== 'function') {
            throw new Error(
                'ag-psd: vendor bundle loaded but window.agPsd.readPsd is not available'
            );
        }
        return lib;
    })();
    win.__OMNI_AG_PSD_READY__ = agPsdLibPromise;
    return agPsdLibPromise;
}

/**
 * The composite PSD result returned to the orchestration layer. The
 * canvas is always populated — when ag-psd returns ImageData instead of
 * a canvas (some browser/build combos do this when `useImageData: true`
 * is set), we materialize one ourselves via `ctx.putImageData`.
 */
export interface ParsedPsd {
    width: number;
    height: number;
    channels: number | undefined;
    bitsPerChannel: number | undefined;
    colorMode: number | undefined;
    /** Composite canvas, ready to draw into the viewport. */
    canvas: HTMLCanvasElement;
    /**
     * Top-level ag-psd layer tree (group nodes have `children`,
     * leaves carry `canvas` / `imageData`). Issue #51 consumes this
     * to render the layer panel and re-composite on visibility
     * toggles. May be undefined if the document has no layers.
     */
    children?: import('./psdLayers').RawAgPsdLayer[];
}

/**
 * Convert an `ImageData` blob to a freshly-created canvas. Used as the
 * fallback path when ag-psd surfaces only `psd.imageData` (no `psd.canvas`).
 */
function imageDataToCanvas(imageData: ImageData): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('PSD: failed to acquire 2D context for composite canvas');
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
}

/**
 * High-level: read the PSD bytes from a `File`, parse via ag-psd, and
 * return the composite + metadata.
 *
 * Throws if:
 *   - the file is over the memory gate (`PSD_MEMORY_GATE_BYTES`);
 *   - ag-psd cannot be loaded (vendor bundle missing);
 *   - ag-psd throws during parse (truncated / corrupt PSD).
 */
export async function parsePsdFromFile(file: File): Promise<ParsedPsd> {
    if (!isPsdSizeAcceptable(file.size)) {
        throw new Error(buildPsdSizeRejectionMessage(file.size));
    }

    const lib = await loadAgPsdLib();
    const buffer = await file.arrayBuffer();

    // `useImageData: true` makes ag-psd materialize the composite into a
    // canvas (or ImageData on environments without canvas decode). We
    // also keep per-layer image data so issue #51's layer panel can
    // recomposite the canvas when the user toggles visibility.
    const psd = lib.readPsd(buffer, {
        useImageData: true,
        skipThumbnail: true
    });

    let canvas: HTMLCanvasElement | undefined = psd.canvas;
    if (!canvas && psd.imageData) {
        canvas = imageDataToCanvas(psd.imageData);
    }
    if (!canvas) {
        throw new Error(
            'PSD: ag-psd returned no composite canvas or imageData; cannot render'
        );
    }

    return {
        width: psd.width,
        height: psd.height,
        channels: psd.channels,
        bitsPerChannel: psd.bitsPerChannel,
        colorMode: psd.colorMode,
        canvas,
        children: psd.children
    };
}

// --- Test-only hooks ----------------------------------------------------

/**
 * Reset the cached ag-psd loader promise. Used by unit tests so each
 * test exercises a fresh load. Not part of the public surface.
 */
export function __resetAgPsdLoaderForTests(): void {
    agPsdLibPromise = undefined;
    if (typeof window !== 'undefined') {
        delete (window as AgPsdGlobalWindow).__OMNI_AG_PSD_READY__;
    }
}
