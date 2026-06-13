// Renderer for the Chrome PDF viewer.
//
// Owns the per-page render lifecycle:
//   - load the pdf.js library from `vendor/pdf.min.mjs` (dynamic import),
//     setting `GlobalWorkerOptions.workerSrc` to `vendor/pdf.worker.min.mjs`
//     before `getDocument` is ever called;
//   - instantiate the `PDFDocumentProxy` from raw bytes;
//   - lay out one wrapper element per page at the viewport-derived size so
//     scroll position and `IntersectionObserver` work without rendering
//     anything yet;
//   - render each page to a canvas only when its wrapper enters (or is
//     near) the viewport;
//   - re-layout on zoom: clear pending render tasks, recompute viewports
//     at the new scale, request a render of the visible pages.
//
// This module deliberately does NOT touch the toolbar / page indicator /
// keyboard shortcuts — those live in `pdfViewer.ts`. It exposes a small
// imperative `PdfRendererHandle` so the entry can drive zoom / dispose.
//
// Scope cuts (issues #17–#23):
//   - thumbnail rendering, password modals, annotation overlays, signature
//     pads, drag-to-reorder thumbs, merge / save are NOT here. The shells
//     they hang off (#thumbnailSidebar, #overlayLayer) are passed through
//     to the entry as plain elements, no behavior wired up.

/* eslint-disable @typescript-eslint/no-explicit-any */
// Justification: pdf.js is loaded dynamically from a vendored .mjs; there
// are no type declarations bundled with the extension, so the public
// surface (`pdfjsLib`, `PDFDocumentProxy`, `PDFPageProxy`) is typed as
// `any`. We compensate by narrowing the API at each call site.

/**
 * Subset of the pdf.js global we depend on. Typed loosely on purpose
 * (see file header).
 */
interface PdfJsLoadingTask {
    promise: Promise<PdfDocumentProxy>;
    destroy?: () => void;
    onPassword?: (updatePassword: (pw: string) => void, reason: number) => void;
}

interface PdfJsLib {
    getDocument(opts: {
        data: Uint8Array;
        isEvalSupported?: boolean;
        password?: string;
    }): PdfJsLoadingTask;
    GlobalWorkerOptions: { workerSrc: string };
}

interface PdfDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfPageProxy>;
    destroy?: () => Promise<void>;
}

export interface PdfPageProxy {
    getViewport(opts: { scale: number }): { width: number; height: number };
    render(opts: {
        canvasContext: CanvasRenderingContext2D;
        viewport: { width: number; height: number };
    }): { promise: Promise<void>; cancel?: () => void };
    cleanup?: () => void;
}

const PDFJS_VENDOR_PATH = 'vendor/pdf.min.mjs';
const PDFJS_WORKER_VENDOR_PATH = 'vendor/pdf.worker.min.mjs';

/**
 * Resolve a vendor file to a URL the page can fetch / import. In a Chrome
 * extension page that is `chrome.runtime.getURL(...)`. We fall back to a
 * relative path when running outside the extension origin (e.g. unit
 * tests, manual file:// debugging) so this module remains importable.
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
 * Lazily-resolved pdf.js handle. We cache the promise so multiple viewer
 * mounts on the same page reuse one library instance.
 */
let pdfJsLibPromise: Promise<PdfJsLib> | undefined;

interface PdfJsBootstrapWindow extends Window {
    __OMNI_PDFJS_WORKER__?: string;
    __OMNI_PDFJS_READY__?: Promise<PdfJsLib>;
}

export async function loadPdfJsLib(): Promise<PdfJsLib> {
    if (pdfJsLibPromise) {
        return pdfJsLibPromise;
    }

    // Honor any pre-existing bootstrap from the per-viewer HTML shell so
    // we line up with the VSCode reference contract
    // (`window.__OMNI_PDFJS_READY__`). When the entry is loaded under the
    // legacy SPA host, neither global is set and we fall back to a direct
    // dynamic import.
    const win = window as PdfJsBootstrapWindow;
    if (win.__OMNI_PDFJS_READY__) {
        pdfJsLibPromise = win.__OMNI_PDFJS_READY__;
        return pdfJsLibPromise;
    }

    const workerUrl = resolveVendorUrl(PDFJS_WORKER_VENDOR_PATH);
    win.__OMNI_PDFJS_WORKER__ = workerUrl;

    pdfJsLibPromise = (async () => {
        const moduleUrl = resolveVendorUrl(PDFJS_VENDOR_PATH);
        // Webpack would otherwise try to resolve this at bundle time; the
        // ignore comment ensures the dynamic import lands at runtime
        // against the extension URL.
        const module = await import(/* webpackIgnore: true */ moduleUrl);
        const lib = (module && (module as { default?: PdfJsLib }).default
            ? (module as { default: PdfJsLib }).default
            : (module as unknown as PdfJsLib));
        if (lib && lib.GlobalWorkerOptions) {
            lib.GlobalWorkerOptions.workerSrc = workerUrl;
        }
        return lib;
    })();
    win.__OMNI_PDFJS_READY__ = pdfJsLibPromise;
    return pdfJsLibPromise;
}

/**
 * Per-page state kept by the renderer. The wrapper is created up-front
 * with the viewport-sized footprint so scroll geometry is stable; the
 * canvas is only attached when the page enters the viewport (or when the
 * caller forces a render via `renderPageNow`).
 */
interface PageRecord {
    pageNumber: number;        // 1-based
    wrapper: HTMLElement;
    canvas: HTMLCanvasElement | undefined;
    rendered: boolean;
    rendering: boolean;
    viewportWidth: number;
    viewportHeight: number;
    page: PdfPageProxy | undefined;
    cancelCurrent: (() => void) | undefined;
}

/**
 * Public handle returned by `mountPdfRenderer`. The entry uses this to
 * change zoom and to tear the renderer down.
 */
export interface PdfRendererHandle {
    readonly numPages: number;
    /** Set the zoom multiplier (1.0 == 100%). Idempotent. */
    setScale(scale: number): Promise<void>;
    /** Tear down: revoke pdf.js resources, disconnect observers. */
    dispose(): void;
    /** Currently-visible page number (1-based). 1 if nothing is visible. */
    getCurrentPageNumber(): number;
    /** Subscribe to current-page changes. Returns an unsubscribe fn. */
    onCurrentPageChanged(listener: (pageNumber: number) => void): () => void;
    /**
     * Borrow the cached `PdfPageProxy` for a given 1-based page number.
     * Used by the thumbnail sidebar (issue #17) so thumbnails reuse the
     * same `PDFDocumentProxy` rather than re-loading the document.
     */
    getPage(pageNumber: number): PdfPageProxy | undefined;
}

export interface MountPdfRendererOptions {
    /** Container for the row of page wrappers (`#pagesContainer`). */
    pagesContainer: HTMLElement;
    /** The scrollport that wraps `pagesContainer` (`#pdfContainer`). */
    scrollContainer: HTMLElement;
    /** PDF bytes (already pulled from `await file.arrayBuffer()`). */
    bytes: Uint8Array;
    /** Initial scale (1.0 == 100%). */
    initialScale: number;
    /**
     * Optional password prompt callback for encrypted PDFs (issue #18).
     * Called by pdf.js with `(updatePassword, reason)`; the caller should
     * resolve the returned promise with the user's input or reject to
     * cancel. `reason` 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD.
     */
    onPasswordRequired?: (reason: number) => Promise<string>;
}

/**
 * Build the renderer. Loads pdf.js, paginates the document, lays out
 * empty wrappers, and starts the IntersectionObserver-driven lazy
 * rendering. The returned handle is async-ready as soon as this resolves.
 */
export async function mountPdfRenderer(
    opts: MountPdfRendererOptions
): Promise<PdfRendererHandle> {
    const { pagesContainer, scrollContainer, bytes, initialScale, onPasswordRequired } = opts;

    const pdfjsLib = await loadPdfJsLib();
    const loadingTask = pdfjsLib.getDocument({
        data: bytes,
        isEvalSupported: false
    });
    if (onPasswordRequired) {
        loadingTask.onPassword = (updatePassword, reason) => {
            onPasswordRequired(reason).then(
                (pw) => updatePassword(pw),
                () => {
                    if (typeof loadingTask.destroy === 'function') {
                        try {
                            loadingTask.destroy();
                        } catch {
                            // best-effort
                        }
                    }
                }
            );
        };
    }
    const doc: PdfDocumentProxy = await loadingTask.promise;

    let scale = initialScale;
    const pages: PageRecord[] = [];

    // ---------- layout pass: empty wrappers sized to the viewport ----------
    pagesContainer.innerHTML = '';
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale });
        const wrapper = document.createElement('div');
        wrapper.className = 'pv-page-wrapper';
        wrapper.dataset.pageNumber = String(i);
        wrapper.style.width = `${viewport.width}px`;
        wrapper.style.height = `${viewport.height}px`;

        const placeholder = document.createElement('div');
        placeholder.className = 'pv-page-placeholder';
        placeholder.textContent = `Page ${i}`;
        wrapper.appendChild(placeholder);

        pagesContainer.appendChild(wrapper);

        pages.push({
            pageNumber: i,
            wrapper,
            canvas: undefined,
            rendered: false,
            rendering: false,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            page,
            cancelCurrent: undefined
        });
    }

    // ---------- lazy render via IntersectionObserver ----------------------
    // The rootMargin pre-renders pages within ~1.5 viewport heights of the
    // visible area, which keeps scroll-feel smooth on 100+ page PDFs while
    // bounding peak memory.
    const observer = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const idx = pages.findIndex((p) => p.wrapper === entry.target);
                if (idx >= 0) {
                    void renderPageIfNeeded(idx);
                }
            }
        },
        {
            root: scrollContainer,
            rootMargin: '150% 0px 150% 0px',
            threshold: 0
        }
    );
    for (const p of pages) {
        observer.observe(p.wrapper);
    }

    async function renderPageIfNeeded(idx: number): Promise<void> {
        const rec = pages[idx];
        if (!rec || rec.rendered || rec.rendering || !rec.page) return;
        rec.rendering = true;
        try {
            const viewport = rec.page.getViewport({ scale });
            rec.viewportWidth = viewport.width;
            rec.viewportHeight = viewport.height;

            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                rec.rendering = false;
                return;
            }

            // Replace the placeholder with the canvas only after we have
            // a context; this avoids flashing a blank white frame when
            // canvas creation fails.
            rec.wrapper.innerHTML = '';
            rec.wrapper.appendChild(canvas);
            rec.canvas = canvas;

            const renderTask = rec.page.render({
                canvasContext: ctx,
                viewport
            });
            rec.cancelCurrent = renderTask.cancel
                ? renderTask.cancel.bind(renderTask)
                : undefined;
            await renderTask.promise;
            rec.rendered = true;
        } catch (err) {
            // Render cancellation throws a "RenderingCancelledException" —
            // swallow it so a quick zoom doesn't surface as an error.
            if (!isRenderCancelled(err)) {
                // Surface other failures via console; the entry doesn't
                // expose a per-page error UI yet.
                // eslint-disable-next-line no-console
                console.warn('[pdf] page render failed', rec.pageNumber, err);
            }
        } finally {
            rec.rendering = false;
            rec.cancelCurrent = undefined;
        }
    }

    // ---------- current-page tracking -------------------------------------
    let currentPageNumber = 1;
    const currentPageListeners = new Set<(n: number) => void>();
    const visibilityRatios = new Map<number, number>();

    const visibilityObserver = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const numAttr = (entry.target as HTMLElement).dataset
                    .pageNumber;
                const num = numAttr ? parseInt(numAttr, 10) : NaN;
                if (Number.isNaN(num)) continue;
                if (entry.isIntersecting) {
                    visibilityRatios.set(num, entry.intersectionRatio);
                } else {
                    visibilityRatios.delete(num);
                }
            }
            // Pick the page with the highest visible ratio. Ties: lowest
            // page number wins (matches the VSCode "1 / N" intuition).
            let best: number | undefined;
            let bestRatio = -1;
            for (const [num, ratio] of visibilityRatios) {
                if (
                    ratio > bestRatio ||
                    (ratio === bestRatio &&
                        (best === undefined || num < best))
                ) {
                    bestRatio = ratio;
                    best = num;
                }
            }
            if (best !== undefined && best !== currentPageNumber) {
                currentPageNumber = best;
                for (const l of currentPageListeners) {
                    try {
                        l(currentPageNumber);
                    } catch {
                        // Listeners must not throw into the observer.
                    }
                }
            }
        },
        {
            root: scrollContainer,
            rootMargin: '0px',
            threshold: [0, 0.25, 0.5, 0.75, 1]
        }
    );
    for (const p of pages) {
        visibilityObserver.observe(p.wrapper);
    }

    // ---------- public handle --------------------------------------------
    const handle: PdfRendererHandle = {
        numPages: doc.numPages,

        async setScale(nextScale: number): Promise<void> {
            if (nextScale === scale) return;
            scale = nextScale;

            // Re-measure every wrapper at the new scale and invalidate the
            // cached canvases. Pages currently in the viewport will be
            // re-rendered by the lazy-render path on the next observer
            // tick (we manually request a render for the current page so
            // the user doesn't see a placeholder during the resize).
            for (const rec of pages) {
                if (rec.cancelCurrent) {
                    try {
                        rec.cancelCurrent();
                    } catch {
                        // best-effort
                    }
                }
                rec.cancelCurrent = undefined;
                rec.rendered = false;
                rec.rendering = false;
                if (rec.page) {
                    const vp = rec.page.getViewport({ scale });
                    rec.viewportWidth = vp.width;
                    rec.viewportHeight = vp.height;
                    rec.wrapper.style.width = `${vp.width}px`;
                    rec.wrapper.style.height = `${vp.height}px`;
                }
                // Reset placeholder so the user sees something while the
                // canvas re-renders at the new scale.
                rec.wrapper.innerHTML = '';
                const placeholder = document.createElement('div');
                placeholder.className = 'pv-page-placeholder';
                placeholder.textContent = `Page ${rec.pageNumber}`;
                rec.wrapper.appendChild(placeholder);
                rec.canvas = undefined;
            }

            // Trigger an immediate render of the page the user is looking
            // at; the IntersectionObserver will handle the rest as they
            // scroll into view.
            const idx = pages.findIndex(
                (p) => p.pageNumber === currentPageNumber
            );
            if (idx >= 0) {
                await renderPageIfNeeded(idx);
            }
        },

        dispose(): void {
            observer.disconnect();
            visibilityObserver.disconnect();
            for (const rec of pages) {
                if (rec.cancelCurrent) {
                    try {
                        rec.cancelCurrent();
                    } catch {
                        // best-effort
                    }
                }
                if (rec.page && typeof rec.page.cleanup === 'function') {
                    try {
                        rec.page.cleanup();
                    } catch {
                        // best-effort
                    }
                }
            }
            if (typeof doc.destroy === 'function') {
                void doc.destroy();
            }
            currentPageListeners.clear();
        },

        getCurrentPageNumber(): number {
            return currentPageNumber;
        },

        onCurrentPageChanged(listener: (n: number) => void): () => void {
            currentPageListeners.add(listener);
            return () => currentPageListeners.delete(listener);
        },

        getPage(pageNumber: number): PdfPageProxy | undefined {
            const idx = pageNumber - 1;
            if (idx < 0 || idx >= pages.length) return undefined;
            return pages[idx]?.page;
        }
    };

    return handle;
}

function isRenderCancelled(err: unknown): boolean {
    if (!err) return false;
    if (typeof err === 'object' && err !== null) {
        const name = (err as { name?: string }).name;
        if (
            name === 'RenderingCancelledException' ||
            name === 'AbortException'
        ) {
            return true;
        }
    }
    return false;
}
