// Lazy loader for the rhwp WASM bundle (`vendor/rhwp.js` +
// `vendor/rhwp_bg.wasm`). Issue #53.
//
// The vendored bundle is wasm-bindgen ESM:
//
//   - `default __wbg_init(module_or_path)` initializes the WASM. When
//     `module_or_path` is omitted it tries `new URL('rhwp_bg.wasm',
//     import.meta.url)`, which resolves against the bundle's URL — that
//     is what we want when the page imports rhwp.js from
//     `chrome.runtime.getURL('vendor/rhwp.js')`. We pass the explicit
//     `chrome.runtime.getURL('vendor/rhwp_bg.wasm')` URL anyway so a
//     surprising bundler / origin still picks the right WASM file.
//
//   - `class HwpDocument` — `new HwpDocument(Uint8Array)` parses HWP bytes.
//
//   - `class HwpViewer` — `new HwpViewer(document)` consumes the document
//     and exposes `pageCount()`, `renderPageSvg(n)`, `renderPageHtml(n)`.
//
// Contract:
//   - `loadRhwp()` is idempotent and returns a cached promise so concurrent
//     mounts share a single WASM instance.
//   - `parseHwp(bytes)` parses a Uint8Array into an `HwpHandle` exposing
//     `pageCount` and `renderPageSvg(n)` for the renderer.
//   - `resolveVendorUrl(path)` is exported so unit tests can verify that
//     `chrome.runtime.getURL` is consulted before falling back to a plain
//     relative path.
//   - `buildLoadErrorMessage(err)` produces the user-facing panel text the
//     orchestration layer renders when WASM init fails.
//
// We deliberately keep the surface tiny — orchestration, DOM, error UI all
// live in `hwpViewerMain.ts`. This file's only job is "give me a parsed
// HWP I can ask for SVG pages from".

/* eslint-disable @typescript-eslint/no-explicit-any */

const RHWP_VENDOR_PATH = 'vendor/rhwp.js';
const RHWP_WASM_VENDOR_PATH = 'vendor/rhwp_bg.wasm';

/**
 * Subset of `HwpDocument` that we use. We only declare the surface that
 * `parseHwp()` consumes so a future rhwp upgrade doesn't drag in a
 * full-fidelity type port.
 */
export interface RhwpDocument {
    pageCount?(): number;
    renderPageSvg?(pageNum: number): string;
    renderPageHtml?(pageNum: number): string;
    free?(): void;
}

/**
 * Subset of `HwpViewer` that the renderer touches.
 */
export interface RhwpViewer {
    pageCount(): number;
    renderPageSvg(pageNum: number): string;
    renderPageHtml?(pageNum: number): string;
    setZoom?(zoom: number): void;
    free?(): void;
}

/**
 * The wasm-bindgen module shape after `__wbg_init` resolves.
 * `init` returns the raw wasm exports (not the JS namespace), so we keep
 * a reference to the imported namespace for class constructors.
 */
export interface RhwpModule {
    default: (input?: any) => Promise<unknown>;
    HwpDocument: new (data: Uint8Array) => RhwpDocument;
    HwpViewer: new (document: RhwpDocument) => RhwpViewer;
    extractThumbnail?: (data: Uint8Array) => unknown;
    init_panic_hook?: () => void;
    version?: () => string;
}

/**
 * Top-level handle returned by `loadRhwp()` — the namespace plus the
 * resolved WASM URL (handy for diagnostics / error messages).
 */
export interface RhwpHandle {
    module: RhwpModule;
    wasmUrl: string;
}

/**
 * What `parseHwp(bytes)` resolves to. We separate `document` (the
 * pageless model) from `viewer` (the page-renderer) so callers can free
 * either independently if they need to.
 */
export interface ParsedHwp {
    viewer: RhwpViewer;
    pageCount: number;
}

/**
 * Resolve a vendor file to a URL the page can fetch / import. Mirrors
 * `pdfRenderer.resolveVendorUrl` so the loader fallback (relative path)
 * works in unit tests and in non-extension hosts.
 *
 * Exported for tests (locateFile path verification — see DoD).
 */
export function resolveVendorUrl(relativePath: string): string {
    if (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.getURL === 'function'
    ) {
        try {
            return chrome.runtime.getURL(relativePath);
        } catch {
            // Outside extension origin — fall through to a relative path.
        }
    }
    return relativePath;
}

/**
 * Resolve the rhwp.js bundle URL. Exported so the loader test can
 * pin the exact vendor path.
 */
export function rhwpModuleUrl(): string {
    return resolveVendorUrl(RHWP_VENDOR_PATH);
}

/**
 * Resolve the rhwp_bg.wasm URL. This is the value we pass to the
 * wasm-bindgen `__wbg_init` so the WASM file is fetched from the
 * extension origin and not from `import.meta.url`-relative guessing
 * (which can mis-resolve when the bundle is mirrored under a different
 * path during tests).
 *
 * Exported for tests.
 */
export function rhwpWasmUrl(): string {
    return resolveVendorUrl(RHWP_WASM_VENDOR_PATH);
}

/**
 * Build the user-facing error message for the HWP error panel. We keep
 * this pure (no DOM) so tests can lock the wording without spinning up
 * jsdom for every assertion.
 */
export function buildLoadErrorMessage(err: unknown): string {
    const detail =
        err instanceof Error
            ? err.message
            : typeof err === 'string'
                ? err
                : 'Unknown error';
    return `Couldn't load HWP renderer: ${detail}`;
}

// rhwp WASM calls globalThis.measureTextWidth(text, font) for HWP text
// layout. Register a Canvas 2D implementation once so every render call
// can use it. The canvas element is reused across calls (one per page
// renders sequentially) to avoid repeated allocation.
function installMeasureTextWidth(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = window as any;
    if (typeof g.measureTextWidth === 'function') return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    // rhwp calls measureTextWidth(font, text) — font is the first argument.
    g.measureTextWidth = (font: string, text: string): number => {
        if (!ctx) return 0;
        ctx.font = font;
        return ctx.measureText(text).width;
    };
}

let pendingLoad: Promise<RhwpHandle> | undefined;

/**
 * Load rhwp.js as an ESM module via dynamic import, then initialize the
 * WASM. Idempotent — repeated calls share the same promise.
 *
 * `webpackIgnore` keeps webpack from trying to resolve the dynamic
 * import at bundle time. The URL is a `chrome-extension://` URL at
 * runtime, which only the browser can resolve.
 */
export function loadRhwp(): Promise<RhwpHandle> {
    if (pendingLoad) return pendingLoad;
    pendingLoad = (async (): Promise<RhwpHandle> => {
        installMeasureTextWidth();
        const moduleUrl = rhwpModuleUrl();
        const wasmUrl = rhwpWasmUrl();
        const mod = (await import(/* webpackIgnore: true */ moduleUrl)) as RhwpModule;
        if (!mod || typeof mod.default !== 'function') {
            throw new Error(
                'rhwp loader: vendor bundle did not expose default __wbg_init'
            );
        }
        if (typeof mod.HwpDocument !== 'function' || typeof mod.HwpViewer !== 'function') {
            throw new Error(
                'rhwp loader: vendor bundle missing HwpDocument / HwpViewer exports'
            );
        }
        // Pass the WASM URL explicitly so `__wbg_init`'s `import.meta.url`
        // fallback never gets in the way (the fallback works in the common
        // case but can mis-resolve when the bundle URL has a query string
        // appended by some hosts).
        await mod.default({ module_or_path: wasmUrl });
        // Best-effort panic-hook install. If the bundle ships without it
        // (older builds) we just skip — it's a diagnostic, not a hard
        // requirement.
        try {
            mod.init_panic_hook?.();
        } catch {
            /* swallow — diagnostic only */
        }
        return { module: mod, wasmUrl };
    })();
    return pendingLoad.catch((err) => {
        // Drop the cached promise on failure so a later retry (e.g. user
        // hits "Refresh") can try again instead of always seeing the
        // sticky failure.
        pendingLoad = undefined;
        throw err;
    });
}

/**
 * Test-only hook. Resets the cached promise so unit tests can exercise
 * the success path twice without leaking module state across tests.
 */
export function __resetRhwpLoaderForTests(): void {
    pendingLoad = undefined;
}

/**
 * Parse an `.hwp` byte buffer and build a viewer. Returns the page count
 * up-front so the orchestration layer can pre-allocate canvas slots
 * before pulling per-page SVG strings.
 */
export async function parseHwp(bytes: Uint8Array): Promise<ParsedHwp> {
    const handle = await loadRhwp();
    const doc = new handle.module.HwpDocument(bytes);
    const pageCount = doc.pageCount?.() ?? 0;
    // Use HwpDocument directly for batch SVG rendering.
    // HwpViewer is a viewport-scheduling controller that requires
    // updateViewport() before renderPageSvg() — without it the viewport
    // is 0×0 and pages render blank. HwpDocument.renderPageSvg() has no
    // such dependency and is the right API for render-all-pages use.
    return { viewer: doc as unknown as RhwpViewer, pageCount };
}
