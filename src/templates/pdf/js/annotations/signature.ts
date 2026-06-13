// Signature annotation renderer + click-handler factory for the Chrome
// PDF viewer (issue #20).
//
// Lifecycle owned here:
//   - "Signature mode" toggle: while active, the page wrappers get a
//     crosshair cursor and clicks anywhere on a page wrapper are
//     intercepted by the handler we hand back to the caller (mirroring
//     `annotations/text.ts`).
//   - On click, we project the screen coordinate back into PDF point
//     space (using the renderer's current scale) and ask the host to
//     open a modal containing a signature pad canvas.
//   - Rendering is independent of mode: the host calls
//     `renderSignatureAnnotations` whenever the store / scale changes;
//     we wipe and re-paint the overlay's signature image nodes for the
//     matching pages.
//
// Coordinate model: see `../pdfAnnotationStore.ts` header. Signatures are
// stored as PNG data URLs sized in PDF points; rendering scales them
// to screen px using the same scale the text annotations use.

import {
    PdfAnnotationStore,
    PdfSignatureAnnotation,
    pdfPointToScreenPx,
    screenPxToPdfPoint
} from '../pdfAnnotationStore';
import {
    SignaturePoint,
    addPoint,
    boundingBox,
    simplifyStroke
} from '../signaturePad';

/** Default signature width in PDF points if the modal can't infer it. */
export const DEFAULT_SIGNATURE_WIDTH = 120;
/** Default signature height in PDF points. */
export const DEFAULT_SIGNATURE_HEIGHT = 60;
/** Default ink color. */
export const DEFAULT_SIGNATURE_COLOR = '#000000';

export interface SignatureAnnotationClickPayload {
    /** 0-based page index of the wrapper that was clicked. */
    pageIndex: number;
    /** Click position in PDF point space (top-left origin). */
    x: number;
    y: number;
}

export interface SignatureAnnotationModeOptions {
    /**
     * Container for `pv-page-wrapper[data-page-number]` elements. We
     * attach a single click handler to the container and let it bubble.
     */
    pagesContainer: HTMLElement;
    /** Returns the renderer's current pdf.js scale (1.0 == 100%). */
    getScale(): number;
    /** Called whenever the user clicks on a page while signature mode is active. */
    onClick(payload: SignatureAnnotationClickPayload): void;
}

export interface SignatureAnnotationModeHandle {
    /** True when signature mode is currently active. */
    isActive(): boolean;
    /** Enter signature mode: enable click capture + crosshair cursor. */
    enable(): void;
    /** Leave signature mode: disable click capture + restore cursor. */
    disable(): void;
    /** Toggle convenience for the toolbar button. */
    toggle(): void;
    /** Tear down listeners + revert any DOM state. */
    dispose(): void;
}

const SIGNATURE_MODE_CSS_CLASS = 'pv-signature-mode';

/**
 * Wire up "click on page → drop signature" behavior. Returns
 * synchronously with a handle the caller (toolbar button, dispose path)
 * drives. Mirrors `attachTextAnnotationMode`.
 */
export function attachSignatureAnnotationMode(
    opts: SignatureAnnotationModeOptions
): SignatureAnnotationModeHandle {
    let active = false;

    const handlePointerDown = (event: MouseEvent): void => {
        if (!active) return;
        const target = event.target as HTMLElement | null;
        if (!target) return;
        const wrapper = target.closest<HTMLElement>(
            '.pv-page-wrapper[data-page-number]'
        );
        if (!wrapper) return;
        // Don't drop a new signature if the click landed on an existing
        // overlay element (e.g. user is clicking to edit / select).
        if (target.closest('.pv-annotation-signature')) return;
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

    // Capture-phase listener so we beat the pdf.js canvas's own
    // selection logic to the punch.
    opts.pagesContainer.addEventListener('mousedown', handlePointerDown, true);

    const setActive = (next: boolean): void => {
        if (active === next) return;
        active = next;
        opts.pagesContainer.classList.toggle(SIGNATURE_MODE_CSS_CLASS, active);
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
            opts.pagesContainer.classList.remove(SIGNATURE_MODE_CSS_CLASS);
            active = false;
        }
    };
}

export interface RenderSignatureAnnotationsOptions {
    /** `#pv-overlayLayer` — the absolutely-positioned overlay container. */
    overlayLayer: HTMLElement;
    /** `#pv-pagesContainer` — used to look up page wrapper offsets. */
    pagesContainer: HTMLElement;
    /** Annotation source. We list all kinds and filter to `signature`. */
    store: PdfAnnotationStore;
    /** Current pdf.js scale (1.0 == 100%). */
    scale: number;
}

/**
 * Wipe and repaint the signature-annotation overlay. Called by the host
 * on store mutations and on scale changes. Every annotation is
 * positioned relative to the overlay layer (which is sibling-positioned
 * over `pv-pagesContainer`), with the offsets derived from each page
 * wrapper's `offsetLeft` / `offsetTop` inside the pages container.
 */
export function renderSignatureAnnotations(
    opts: RenderSignatureAnnotationsOptions
): void {
    const { overlayLayer, pagesContainer, store, scale } = opts;

    // Remove only signature annotation nodes; text annotations (#19) and
    // other overlays (#21 selection box) live alongside us in the same
    // layer.
    const stale = overlayLayer.querySelectorAll('.pv-annotation-signature');
    stale.forEach((el) => el.remove());

    const all = store.listAll();
    for (const annotation of all) {
        if (annotation.kind !== 'signature') continue;
        const node = buildSignatureAnnotationNode(annotation, pagesContainer, scale);
        if (node) {
            overlayLayer.appendChild(node);
        }
    }
}

/**
 * Build one `<img class="pv-annotation-signature">` for a single
 * signature annotation, positioned in overlay-px space. Exported for
 * tests.
 */
export function buildSignatureAnnotationNode(
    annotation: PdfSignatureAnnotation,
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
    const width = pdfPointToScreenPx(annotation.width, scale);
    const height = pdfPointToScreenPx(annotation.height, scale);

    const offsetLeft = wrapper.offsetLeft;
    const offsetTop = wrapper.offsetTop;

    const node = document.createElement('img');
    node.className = 'pv-annotation-signature';
    node.dataset.annotationId = annotation.id;
    node.dataset.pageNumber = String(pageNumber);
    node.src = annotation.dataUrl;
    node.alt = 'signature';
    // Browsers occasionally drag the underlying <img>; suppress so a
    // signature drag doesn't kick off the native image-drag overlay
    // (issue #21 will replace this with explicit drag-to-move).
    node.draggable = false;
    node.style.position = 'absolute';
    node.style.left = `${offsetLeft + screenX}px`;
    node.style.top = `${offsetTop + screenY}px`;
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;

    return node;
}

/** Default pen line width inside the signature canvas (canvas px). */
export const SIGNATURE_PEN_WIDTH = 2.5;

export interface SignaturePadHandle {
    /** True when the user has drawn at least one stroke. */
    hasInk(): boolean;
    /** Wipe every stroke from the canvas. */
    clear(): void;
    /**
     * Returns the current ink color (CSS hex). Mostly for tests; the
     * caller usually drives the color via the supplied input.
     */
    getColor(): string;
    /** Re-render with the current stroke list (e.g. after color change). */
    redraw(): void;
    /**
     * Export the current canvas to a PNG data URL. Returns `undefined`
     * if no ink has been drawn (so the caller can disable the confirm
     * button until the user actually signs something).
     */
    toDataUrl(): string | undefined;
    /** Bounding box of every drawn sample, in canvas-px space. */
    boundingBox(): { x: number; y: number; width: number; height: number };
    /** Tear down every listener attached to the canvas. */
    dispose(): void;
}

export interface AttachSignaturePadOptions {
    /** The `<canvas>` element used as the drawing surface. */
    canvas: HTMLCanvasElement;
    /** Initial ink color. Defaults to `DEFAULT_SIGNATURE_COLOR`. */
    initialColor?: string;
    /** Notified after each completed stroke (mouseup / pointerup / touchend). */
    onStrokeEnd?(): void;
}

/**
 * Wire pointer + touch input into a smoothed signature pad. The caller
 * supplies the `<canvas>`; we own the listeners + the per-stroke buffer
 * and expose `toDataUrl()` for the modal's confirm path. Pen smoothing
 * uses the pure helpers from `../signaturePad` so the math stays
 * testable.
 *
 * The pad supports mouse and touch; we listen for the union of pointer
 * events (when available) and mouse + touch events (fallback). Each
 * stroke lives in its own array; clearing or undoing a stroke is just
 * a list mutation followed by a `redraw()`.
 */
export function attachSignaturePad(
    opts: AttachSignaturePadOptions
): SignaturePadHandle {
    const { canvas } = opts;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        // Without a 2D context we still need to return a live handle so
        // the caller's lifecycle code doesn't have to special-case it.
        return makeNoopPadHandle(opts.initialColor ?? DEFAULT_SIGNATURE_COLOR);
    }

    let color = opts.initialColor ?? DEFAULT_SIGNATURE_COLOR;
    /** Each completed (or in-flight) stroke as a list of canvas-px samples. */
    const strokes: SignaturePoint[][] = [];
    let active: SignaturePoint[] | undefined;
    let activePointerId: number | undefined;

    const localPoint = (clientX: number, clientY: number): SignaturePoint => {
        const rect = canvas.getBoundingClientRect();
        // Map from CSS-px coords into the canvas's intrinsic coord
        // space (canvas.width / canvas.height) so the ink looks the
        // same regardless of any DPR scaling the caller applied.
        const scaleX = rect.width === 0 ? 1 : canvas.width / rect.width;
        const scaleY = rect.height === 0 ? 1 : canvas.height / rect.height;
        return {
            x: (clientX - rect.left) * scaleX,
            y: (clientY - rect.top) * scaleY
        };
    };

    const beginStroke = (point: SignaturePoint): void => {
        active = [point];
        strokes.push(active);
        // Paint a tiny dot immediately so a tap-without-drag still
        // leaves a mark.
        ctx.save();
        applyPenStyle(ctx, color);
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
        ctx.restore();
    };

    const extendStroke = (point: SignaturePoint): void => {
        if (!active) return;
        const last = active[active.length - 1];
        if (last && last.x === point.x && last.y === point.y) return;
        // Use the smoothed midpoint segment so the live stroke matches
        // the eventual `paintStroke` redraw (no flicker on commit).
        const segment = addPoint(last, point);
        ctx.save();
        applyPenStyle(ctx, color);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.quadraticCurveTo(segment.controlX, segment.controlY, segment.endX, segment.endY);
        ctx.stroke();
        ctx.restore();
        active.push(point);
    };

    const endStroke = (point?: SignaturePoint): void => {
        if (!active) return;
        if (point) {
            const last = active[active.length - 1];
            if (!last || last.x !== point.x || last.y !== point.y) {
                ctx.save();
                applyPenStyle(ctx, color);
                ctx.beginPath();
                ctx.moveTo(last.x, last.y);
                ctx.lineTo(point.x, point.y);
                ctx.stroke();
                ctx.restore();
                active.push(point);
            }
        }
        // Decimate the recorded samples now so a redraw after a color
        // change uses the same simplified buffer the next stroke does.
        const simplified = simplifyStroke(active);
        strokes[strokes.length - 1] = simplified;
        active = undefined;
        activePointerId = undefined;
        opts.onStrokeEnd?.();
    };

    const isPrimaryButton = (e: MouseEvent): boolean => {
        // mousedown for the left button reports button=0; for pointer
        // events the same holds. Touch-derived pointer events report
        // button=0 too.
        return e.button === 0;
    };

    // --- pointer event path (covers mouse + touch + pen) -----------
    const onPointerDown = (e: PointerEvent): void => {
        if (!isPrimaryButton(e)) return;
        if (active) return; // already drawing — ignore secondary pointers
        activePointerId = e.pointerId;
        try {
            canvas.setPointerCapture(e.pointerId);
        } catch {
            // setPointerCapture can throw in jsdom; safe to ignore.
        }
        e.preventDefault();
        beginStroke(localPoint(e.clientX, e.clientY));
    };
    const onPointerMove = (e: PointerEvent): void => {
        if (!active) return;
        if (activePointerId !== undefined && e.pointerId !== activePointerId) return;
        e.preventDefault();
        extendStroke(localPoint(e.clientX, e.clientY));
    };
    const onPointerUp = (e: PointerEvent): void => {
        if (!active) return;
        if (activePointerId !== undefined && e.pointerId !== activePointerId) return;
        e.preventDefault();
        endStroke(localPoint(e.clientX, e.clientY));
        try {
            canvas.releasePointerCapture(e.pointerId);
        } catch {
            // ignore
        }
    };
    const onPointerCancel = (e: PointerEvent): void => {
        if (!active) return;
        if (activePointerId !== undefined && e.pointerId !== activePointerId) return;
        endStroke();
    };

    // --- legacy mouse fallback -------------------------------------
    const onMouseDown = (e: MouseEvent): void => {
        if (!isPrimaryButton(e)) return;
        if (active) return;
        e.preventDefault();
        beginStroke(localPoint(e.clientX, e.clientY));
    };
    const onMouseMove = (e: MouseEvent): void => {
        if (!active) return;
        e.preventDefault();
        extendStroke(localPoint(e.clientX, e.clientY));
    };
    const onMouseUp = (e: MouseEvent): void => {
        if (!active) return;
        e.preventDefault();
        endStroke(localPoint(e.clientX, e.clientY));
    };

    // --- legacy touch fallback -------------------------------------
    const onTouchStart = (e: TouchEvent): void => {
        if (active) return;
        const t = e.changedTouches[0];
        if (!t) return;
        e.preventDefault();
        beginStroke(localPoint(t.clientX, t.clientY));
    };
    const onTouchMove = (e: TouchEvent): void => {
        if (!active) return;
        const t = e.changedTouches[0];
        if (!t) return;
        e.preventDefault();
        extendStroke(localPoint(t.clientX, t.clientY));
    };
    const onTouchEnd = (e: TouchEvent): void => {
        if (!active) return;
        const t = e.changedTouches[0];
        e.preventDefault();
        endStroke(t ? localPoint(t.clientX, t.clientY) : undefined);
    };

    // PointerEvent is widely supported; fall back to mouse + touch when
    // it isn't (or in jsdom test environments).
    const supportsPointer = typeof window !== 'undefined' && 'PointerEvent' in window;
    if (supportsPointer) {
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointercancel', onPointerCancel);
        canvas.addEventListener('pointerleave', onPointerCancel);
    } else {
        canvas.addEventListener('mousedown', onMouseDown);
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('mouseleave', onMouseUp);
        canvas.addEventListener('touchstart', onTouchStart, { passive: false });
        canvas.addEventListener('touchmove', onTouchMove, { passive: false });
        canvas.addEventListener('touchend', onTouchEnd);
        canvas.addEventListener('touchcancel', onTouchEnd);
    }

    const redraw = (): void => {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        for (const stroke of strokes) {
            paintStrokeOnCanvas(ctx, stroke, color);
        }
    };

    const setColor = (next: string): void => {
        if (!next) return;
        color = next;
        // Re-render existing strokes with the new color so the user sees
        // an immediate update. Each stroke uses the *current* color when
        // we redraw — earlier strokes are not preserved with their
        // original color (matches the simple "single-color" UX of #20).
        redraw();
    };

    return {
        hasInk(): boolean {
            return strokes.some((s) => s.length > 0);
        },
        clear(): void {
            strokes.length = 0;
            active = undefined;
            activePointerId = undefined;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.restore();
        },
        getColor(): string {
            return color;
        },
        // Expose color setter via redraw + module-level helper so tests
        // can flip the color without going through DOM events.
        redraw,
        toDataUrl(): string | undefined {
            if (!strokes.some((s) => s.length > 0)) return undefined;
            try {
                return canvas.toDataURL('image/png');
            } catch {
                return undefined;
            }
        },
        boundingBox(): { x: number; y: number; width: number; height: number } {
            const all: SignaturePoint[] = [];
            for (const stroke of strokes) {
                for (const p of stroke) all.push(p);
            }
            return boundingBox(all);
        },
        dispose(): void {
            if (supportsPointer) {
                canvas.removeEventListener('pointerdown', onPointerDown);
                canvas.removeEventListener('pointermove', onPointerMove);
                canvas.removeEventListener('pointerup', onPointerUp);
                canvas.removeEventListener('pointercancel', onPointerCancel);
                canvas.removeEventListener('pointerleave', onPointerCancel);
            } else {
                canvas.removeEventListener('mousedown', onMouseDown);
                canvas.removeEventListener('mousemove', onMouseMove);
                canvas.removeEventListener('mouseup', onMouseUp);
                canvas.removeEventListener('mouseleave', onMouseUp);
                canvas.removeEventListener('touchstart', onTouchStart);
                canvas.removeEventListener('touchmove', onTouchMove);
                canvas.removeEventListener('touchend', onTouchEnd);
                canvas.removeEventListener('touchcancel', onTouchEnd);
            }
        },
        // Internal — exposed for the modal's color-input wiring.
        ...({ setColor } as object)
    } as SignaturePadHandle & { setColor(next: string): void };
}

function applyPenStyle(ctx: CanvasRenderingContext2D, color: string): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = SIGNATURE_PEN_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
}

function paintStrokeOnCanvas(
    ctx: CanvasRenderingContext2D,
    points: ReadonlyArray<SignaturePoint>,
    color: string
): void {
    if (points.length === 0) return;
    ctx.save();
    applyPenStyle(ctx, color);
    ctx.beginPath();
    if (points.length === 1) {
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[0].x, points[0].y);
    } else {
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            const segment = addPoint(points[i - 1], points[i]);
            ctx.quadraticCurveTo(
                segment.controlX,
                segment.controlY,
                segment.endX,
                segment.endY
            );
        }
        const last = points[points.length - 1];
        ctx.lineTo(last.x, last.y);
    }
    ctx.stroke();
    ctx.restore();
}

function makeNoopPadHandle(initialColor: string): SignaturePadHandle {
    return {
        hasInk: () => false,
        clear: () => {},
        getColor: () => initialColor,
        redraw: () => {},
        toDataUrl: () => undefined,
        boundingBox: () => ({ x: 0, y: 0, width: 0, height: 0 }),
        dispose: () => {}
    };
}
