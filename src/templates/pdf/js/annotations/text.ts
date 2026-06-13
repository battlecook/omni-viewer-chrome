// Text annotation renderer + click-handler factory for the Chrome PDF
// viewer (issue #19).
//
// Lifecycle owned here:
//   - "Text mode" toggle: while active, the page wrappers get a crosshair
//     cursor and clicks anywhere on a page wrapper are intercepted by the
//     handler we hand back to the caller.
//   - On click, we project the screen coordinate back into PDF point space
//     (using the renderer's current scale) and ask the host to open a
//     modal asking for text / size / color.
//   - Rendering is independent of mode: the host calls
//     `renderTextAnnotations` whenever the store / scale changes; we wipe
//     and re-paint the overlay's text DOM nodes for the matching pages.
//
// Coordinate model: see `../pdfAnnotationStore.ts` header. We never store
// screen px; both directions of conversion go through
// `pdfPointToScreenPx` / `screenPxToPdfPoint`.

import {
    PdfAnnotationStore,
    PdfTextAnnotation,
    pdfPointToScreenPx,
    screenPxToPdfPoint
} from '../pdfAnnotationStore';

/** Default text size in PDF points if the user doesn't supply one. */
export const DEFAULT_TEXT_ANNOTATION_SIZE = 16;
/** Default ink color (`#000000`) if the user doesn't supply one. */
export const DEFAULT_TEXT_ANNOTATION_COLOR = '#000000';

export interface TextAnnotationClickPayload {
    /** 0-based page index of the wrapper that was clicked. */
    pageIndex: number;
    /** Click position in PDF point space (top-left origin). */
    x: number;
    y: number;
}

export interface TextAnnotationModeOptions {
    /**
     * Container for `pv-page-wrapper[data-page-number]` elements. We attach
     * a single click handler to the container and let it bubble.
     */
    pagesContainer: HTMLElement;
    /** Returns the renderer's current pdf.js scale (1.0 == 100%). */
    getScale(): number;
    /** Called whenever the user clicks on a page while text mode is active. */
    onClick(payload: TextAnnotationClickPayload): void;
}

export interface TextAnnotationModeHandle {
    /** True when text mode is currently active. */
    isActive(): boolean;
    /** Enter text mode: enable click capture + crosshair cursor. */
    enable(): void;
    /** Leave text mode: disable click capture + restore cursor. */
    disable(): void;
    /** Toggle convenience for the toolbar button. */
    toggle(): void;
    /** Tear down listeners + revert any DOM state. */
    dispose(): void;
}

const TEXT_MODE_CSS_CLASS = 'pv-text-mode';

/**
 * Wire up "click on page → drop text" behavior. Returns synchronously with
 * a handle the caller (toolbar button, dispose path) drives.
 */
export function attachTextAnnotationMode(
    opts: TextAnnotationModeOptions
): TextAnnotationModeHandle {
    let active = false;

    const handlePointerDown = (event: MouseEvent): void => {
        if (!active) return;
        const target = event.target as HTMLElement | null;
        if (!target) return;
        const wrapper = target.closest<HTMLElement>(
            '.pv-page-wrapper[data-page-number]'
        );
        if (!wrapper) return;
        // Don't drop a new annotation if the click landed on an existing
        // overlay element (e.g. user is clicking to edit / select).
        if (target.closest('.pv-annotation-text')) return;

        event.preventDefault();
        event.stopPropagation();

        const pageNumberAttr = wrapper.dataset.pageNumber;
        const pageNumber = pageNumberAttr ? parseInt(pageNumberAttr, 10) : NaN;
        if (Number.isNaN(pageNumber) || pageNumber < 1) return;
        const pageIndex = pageNumber - 1;

        const rect = wrapper.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        const scale = opts.getScale();
        const x = screenPxToPdfPoint(offsetX, scale);
        const y = screenPxToPdfPoint(offsetY, scale);

        opts.onClick({ pageIndex, x, y });
    };

    // Capture-phase listener so we beat the pdf.js canvas's own selection
    // logic to the punch.
    opts.pagesContainer.addEventListener('mousedown', handlePointerDown, true);

    const setActive = (next: boolean): void => {
        if (active === next) return;
        active = next;
        opts.pagesContainer.classList.toggle(TEXT_MODE_CSS_CLASS, active);
    };

    return {
        isActive(): boolean {
            return active;
        },
        enable(): void {
            setActive(true);
        },
        disable(): void {
            setActive(false);
        },
        toggle(): void {
            setActive(!active);
        },
        dispose(): void {
            opts.pagesContainer.removeEventListener(
                'mousedown',
                handlePointerDown,
                true
            );
            opts.pagesContainer.classList.remove(TEXT_MODE_CSS_CLASS);
            active = false;
        }
    };
}

export interface RenderTextAnnotationsOptions {
    /** `#pv-overlayLayer` — the absolutely-positioned overlay container. */
    overlayLayer: HTMLElement;
    /** `#pv-pagesContainer` — used to look up page wrapper offsets. */
    pagesContainer: HTMLElement;
    /** Annotation source. We list all kinds and filter to `text`. */
    store: PdfAnnotationStore;
    /** Current pdf.js scale (1.0 == 100%). */
    scale: number;
}

/**
 * Wipe and repaint the text-annotation overlay. Called by the host on
 * store mutations and on scale changes. Every annotation is positioned
 * relative to the overlay layer (which is sibling-positioned over
 * `pv-pagesContainer`), with the offsets derived from each page wrapper's
 * `offsetLeft` / `offsetTop` inside the pages container.
 */
export function renderTextAnnotations(
    opts: RenderTextAnnotationsOptions
): void {
    const { overlayLayer, pagesContainer, store, scale } = opts;

    // Remove only text annotation nodes; signature annotations (#20) and
    // other overlays (#21 selection box) live alongside us in the same
    // layer.
    const stale = overlayLayer.querySelectorAll('.pv-annotation-text');
    stale.forEach((el) => el.remove());

    const all = store.listAll();
    for (const annotation of all) {
        if (annotation.kind !== 'text') continue;
        const node = buildTextAnnotationNode(annotation, pagesContainer, scale);
        if (node) {
            overlayLayer.appendChild(node);
        }
    }
}

/**
 * Build one `<div class="pv-annotation-text">` for a single text
 * annotation, positioned in overlay-px space. Exported for tests.
 */
export function buildTextAnnotationNode(
    annotation: PdfTextAnnotation,
    pagesContainer: HTMLElement,
    scale: number
): HTMLElement | null {
    const pageNumber = annotation.pageIndex + 1;
    const wrapper = pagesContainer.querySelector<HTMLElement>(
        `.pv-page-wrapper[data-page-number="${pageNumber}"]`
    );
    if (!wrapper) return null;

    const screenX = pdfPointToScreenPx(annotation.x, scale);
    const screenY = pdfPointToScreenPx(annotation.y, scale);

    // The overlay layer covers `pv-pdfContainer` (same parent as the pages
    // container). We translate via the wrapper's offset inside that
    // parent so annotations stay glued to their page through scrolling
    // (the overlay scrolls with the container by virtue of being inside
    // it).
    const offsetLeft = wrapper.offsetLeft;
    const offsetTop = wrapper.offsetTop;

    const node = document.createElement('div');
    node.className = 'pv-annotation-text';
    node.dataset.annotationId = annotation.id;
    node.dataset.pageNumber = String(pageNumber);
    node.style.position = 'absolute';
    node.style.left = `${offsetLeft + screenX}px`;
    node.style.top = `${offsetTop + screenY}px`;
    node.style.fontSize = `${annotation.size * scale}px`;
    node.style.color = annotation.color;
    node.style.lineHeight = '1';
    node.style.whiteSpace = 'pre';
    node.textContent = annotation.text;

    return node;
}
