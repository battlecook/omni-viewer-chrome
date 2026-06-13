// Issue #79 — pdf.js mode hook for the PPT viewer.
//
// Chrome Web Store builds cannot exec LibreOffice / `soffice`, so the
// VSCode original's "convert to PDF and feed it to pdf.js" fallback
// cannot be ported verbatim. This module is the structural placeholder
// for the path: if some future feature (or a user-supplied pre-converted
// PDF) hands the PPT viewer raw PDF bytes, we render them through the
// **same** pdf.js loader the PDF viewer uses (`loadPdfJsLib` from
// `pdfRenderer.ts`) — no duplicate vendor bundle, no parallel worker
// bootstrap.
//
// Issue #81 extension: each rendered page now emits a
// `<article class="pv-slide pv-pdf-mode-page" data-page="N" data-index="i">`
// container, mirroring the XML continuous-mode markup so the surrounding
// toolbar (slide dropdown jump, render-progress label, render-token
// cancellation) can treat PDF mode and XML continuous mode uniformly.
//
// What is real here:
//   - `renderPdfSlides(pdfBytes, container, options?)` — paints every PDF
//     page to a `<canvas>` in a continuous list. Each page is wrapped in
//     a `.pv-slide` article tagged with `data-page`. Accepts an optional
//     `signal` (token-cancellation hook), `onProgress` callback, and
//     `scale` for zoom support.
//
// What is intentionally stubbed:
//   - The producer side. Nothing in the Chrome extension currently
//     creates PDF bytes from a `.ppt` / `.pptx`. Wiring up Native
//     Messaging / a remote converter is out of scope (see
//     `docs/ppt-parity.md`).
//   - Per-page lazy rendering / `IntersectionObserver`. The PDF viewer
//     does this for its own performance budget; the PPT mode hook
//     renders eagerly (matching the VSCode original's `renderPdfSlides`
//     and the XML continuous mode added in issue #81).

import { loadPdfJsLib, type PdfPageProxy } from '../../../templates/pdf/js/pdfRenderer';

/**
 * Handle returned by `renderPdfSlides`. Mirrors the legacy / XML
 * renderer's `RenderedSlideHandle` shape so the PPT viewer can manage
 * lifecycle uniformly. `revoke` is a no-op today (the canvases are
 * detached when the container is cleared) but exists so a future pdf.js
 * upgrade can release page proxies without changing the call site.
 */
export interface PdfModeHandle {
    readonly numPages: number;
    revoke(): void;
}

/**
 * Optional knobs for `renderPdfSlides`. All fields are optional — the
 * defaults preserve the issue #79 behaviour. Issue #81 added these for
 * the continuous-render orchestration (token cancellation, progress
 * indicator, zoom support).
 */
export interface RenderPdfSlidesOptions {
    /**
     * Token-cancellation hook. Called before starting each page and
     * before the per-page yield; when it returns true, the loop stops
     * early without throwing. Already-painted canvases stay attached
     * (we never tear down partially-rendered output).
     */
    isCancelled?: () => boolean;
    /**
     * Fired after each page render with the 1-based page number and
     * the document's total page count. Designed to drive the toolbar
     * "Rendering slides… (N/total)" label.
     */
    onProgress?: (current: number, total: number) => void;
    /**
     * pdf.js viewport scale (`1.0` = native). Used to re-render at a
     * higher resolution when the user changes zoom. The XML continuous
     * mode achieves zoom via CSS transform; pdf.js canvases must be
     * re-rasterised at the target scale to stay crisp, so we accept
     * the scale explicitly and document re-render as a known cost.
     */
    scale?: number;
}

/**
 * Render a sequence of PDF pages into a continuous list inside
 * `container`. Each page becomes a `<article class="pv-slide
 * pv-pdf-mode-page" data-page="N" data-index="i">` wrapper, so the
 * surrounding toolbar (continuous mode in `pptViewerMain.ts`) can find
 * pages by `[data-page=N]` for dropdown jump.
 *
 * Designed to be invoked once per render pass; callers that need to
 * re-render at a new zoom should clear `container` first.
 */
export async function renderPdfSlides(
    pdfBytes: Uint8Array,
    container: HTMLElement,
    options: RenderPdfSlidesOptions = {}
): Promise<PdfModeHandle> {
    if (!container) {
        throw new Error('renderPdfSlides: container element is required');
    }
    if (!pdfBytes || pdfBytes.length === 0) {
        return { numPages: 0, revoke: () => undefined };
    }

    // Reuse the PDF viewer's loader. This intentionally shares the same
    // module-scope cached promise so the worker URL and pdf.js library
    // instance are not duplicated when both viewers are loaded in the
    // same tab.
    const pdfjsLib = await loadPdfJsLib();

    const loadingTask = pdfjsLib.getDocument({
        data: pdfBytes,
        isEvalSupported: false
    });
    const doc = await loadingTask.promise;

    container.innerHTML = '';
    container.classList.add('pv-pdf-mode-host');

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const scale = (typeof options.scale === 'number' && options.scale > 0)
        ? options.scale
        : 1;
    const isCancelled = options.isCancelled ?? (() => false);
    const onProgress = options.onProgress;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        if (isCancelled()) break;
        try {
            const page: PdfPageProxy = await doc.getPage(pageNum);
            if (isCancelled()) break;
            const viewport = page.getViewport({ scale });

            const wrapper = document.createElement('article');
            // `pv-slide` keeps the markup uniform with the XML continuous
            // mode so the dropdown jump's `[data-page=N]` selector
            // matches PDF and XML pages without per-mode branching.
            wrapper.className = 'pv-slide pv-pdf-mode-page';
            wrapper.dataset.page = String(pageNum);
            wrapper.dataset.index = String(pageNum - 1);
            wrapper.style.position = 'relative';
            wrapper.style.margin = '12px auto';
            wrapper.style.boxShadow = '0 1px 4px rgba(0, 0, 0, 0.18)';
            wrapper.style.background = '#ffffff';
            wrapper.style.width = `${Math.round(viewport.width)}px`;
            wrapper.style.height = `${Math.round(viewport.height)}px`;
            container.appendChild(wrapper);

            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width * dpr);
            canvas.height = Math.floor(viewport.height * dpr);
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.display = 'block';
            wrapper.appendChild(canvas);

            const ctx = canvas.getContext('2d');
            if (!ctx) continue;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            await page.render({ canvasContext: ctx, viewport }).promise;
            if (onProgress) onProgress(pageNum, doc.numPages);
        } catch {
            // Best-effort: a broken page should not abort the whole
            // render — leave the wrapper as a blank placeholder.
        }
    }

    const numPages = doc.numPages;
    return {
        numPages,
        revoke(): void {
            // pdf.js documents are reference-counted by the loader; we
            // do not call `destroy()` here so a future caller that
            // depends on the same cached library handle is unaffected.
            // The container's children are detached by the caller when
            // remounting, which is sufficient for memory reclamation in
            // the current single-deck-at-a-time UX.
        }
    };
}
