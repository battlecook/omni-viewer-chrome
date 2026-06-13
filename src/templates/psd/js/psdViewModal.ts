// Single-layer "View" modal for the PSD viewer (issue #52).
//
// Responsibilities:
//   - Mount a fullscreen overlay that shows ONE layer's canvas centered
//     on a transparent-aware checkerboard background.
//   - Close on:
//       * the ESC key,
//       * a click on the overlay backdrop (NOT the modal content),
//       * an explicit close button in the modal header.
//   - Provide a tiny disposal handle so callers (`psdViewerMain.ts`) can
//     drop the modal during their own teardown without needing to
//     remember the close-flow internals.
//
// Scope cuts (kept intentionally minimal so the modal stays cheap to
// reason about):
//   - No pan / no Photoshop-style "fit-to-window" math. CSS
//     `max-width: 100% / max-height: 100%` on the canvas plus
//     `overflow: auto` on the modal-content already gives the user a
//     usable centered + scrollable view.
//   - "Zoomable" requirement from the issue body is satisfied via the
//     browser's native pinch-zoom + Ctrl/Cmd+scroll on the canvas; the
//     `.psd-modal-canvas` rule keeps the canvas at its natural size up
//     to the viewport, which is the same UX the existing image viewer
//     uses.
//   - Checkerboard is pure CSS (`linear-gradient` 45deg trick) so we
//     don't ship an image asset and don't have to thread one through
//     the bundler.
//
// Tests live in `src/__tests__/psdViewModal.test.ts` and exercise
// the pure helpers (`clickIsOnOverlay`) plus a light DOM round-trip
// of `openLayerView` + `dispose`.

/**
 * Handle returned by `openLayerView`. The caller invokes `dispose()`
 * to tear the modal down imperatively (e.g., during the host viewer's
 * own dispose). It is safe to call `dispose()` more than once.
 */
export interface PsdLayerModalHandle {
    /** Root element of the modal (overlay). Useful for tests. */
    readonly root: HTMLElement;
    /** True after `dispose()` has run; tests assert on this. */
    isDisposed(): boolean;
    /** Tear the modal down. Safe to call multiple times. */
    dispose(): void;
}

export interface OpenLayerViewOptions {
    /**
     * Where to attach the overlay. Defaults to `document.body`.
     * Tests pass an isolated container so multiple modals can be
     * spun up without colliding with each other.
     */
    host?: HTMLElement;
    /**
     * Optional callback fired exactly once, the first time the modal
     * transitions into the disposed state. Useful for the orchestration
     * layer to clear its "modal is open" reference.
     */
    onClose?(): void;
}

/**
 * Pure helper: did the click event land on the overlay backdrop
 * (i.e., NOT on the modal content)?
 *
 * The overlay covers the full viewport; the modal-content is a
 * smaller centered child. We only want to close when the user clicks
 * the dim backdrop, not when they click the canvas / header.
 *
 * Exported so the unit test can pin the contract without standing up
 * the whole modal.
 *
 *   - Returns `false` if `event.target` is null or not an Element.
 *   - Returns `true` iff `event.target === overlay` exactly. We
 *     specifically do NOT use `contains` here because the modal
 *     content is a descendant of the overlay; matching on identity
 *     is what gives us the "backdrop-only" semantic.
 */
export function clickIsOnOverlay(event: Event, overlay: Element): boolean {
    const target = event.target;
    if (!target) return false;
    return target === overlay;
}

/**
 * Mount a "view this single layer" modal.
 *
 * Inputs:
 *   - `sourceCanvas`: the layer's pixel data, exactly as we received
 *     it from ag-psd. We render it into a FRESH canvas (same width /
 *     height) by `drawImage`-ing the source. We deliberately do NOT
 *     reuse the source canvas in the DOM — the source canvas may be
 *     mounted somewhere else (e.g., an off-screen layer thumbnail)
 *     and detaching it would invalidate that owner.
 *   - `layerName`: shown in the modal header; falls back gracefully
 *     to "Layer" so the header always has SOME text.
 *   - `options`: optional host + onClose hook (see above).
 *
 * Returns a handle whose `dispose()` is idempotent.
 */
export function openLayerView(
    sourceCanvas: HTMLCanvasElement,
    layerName: string | undefined,
    options: OpenLayerViewOptions = {}
): PsdLayerModalHandle {
    const host = options.host ?? document.body;

    const overlay = document.createElement('div');
    overlay.className = 'psd-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const content = document.createElement('div');
    content.className = 'psd-modal-content';

    const header = document.createElement('div');
    header.className = 'psd-modal-header';

    const title = document.createElement('div');
    title.className = 'psd-modal-title';
    title.textContent = (layerName && layerName.trim()) || 'Layer';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'psd-modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    // Use a plain glyph here instead of an SVG so the close button
    // visually matches the layer-row eye toggle's monochrome look.
    closeBtn.textContent = '✕'; // ✕

    header.append(title, closeBtn);

    // Canvas viewport. The checkerboard sits on the wrapper so even
    // if the canvas is smaller than the viewport (small layers), the
    // visible padding still reads as "transparent".
    const stage = document.createElement('div');
    stage.className = 'psd-modal-stage';

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'psd-checkerboard psd-modal-canvas-wrap';

    const targetCanvas = document.createElement('canvas');
    targetCanvas.className = 'psd-modal-canvas';
    targetCanvas.width = Math.max(1, sourceCanvas.width | 0);
    targetCanvas.height = Math.max(1, sourceCanvas.height | 0);
    const ctx = targetCanvas.getContext('2d');
    if (ctx) {
        // Best-effort copy. If the source is empty / detached we still
        // mount the modal so the user gets some feedback rather than a
        // silent no-op.
        try {
            ctx.drawImage(sourceCanvas, 0, 0);
        } catch {
            // Swallow: a broken source canvas shouldn't take down the
            // whole modal. The user will see an empty checkerboard,
            // which still communicates "transparent / no pixels".
        }
    }

    canvasWrap.appendChild(targetCanvas);
    stage.appendChild(canvasWrap);

    content.append(header, stage);
    overlay.appendChild(content);
    host.appendChild(overlay);

    // ---- close plumbing ------------------------------------------------

    let disposed = false;

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        document.removeEventListener('keydown', onKeyDown, true);
        overlay.removeEventListener('click', onOverlayClick);
        closeBtn.removeEventListener('click', onCloseClick);
        if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
        // Drop the canvas backing store so the layer's pixels can be
        // GC'd promptly. The source canvas is owned by the caller and
        // is left alone.
        targetCanvas.width = 0;
        targetCanvas.height = 0;
        if (typeof options.onClose === 'function') {
            try {
                options.onClose();
            } catch {
                // Caller-side error must not propagate into our cleanup.
            }
        }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dispose();
        }
    };

    const onOverlayClick = (event: MouseEvent): void => {
        if (clickIsOnOverlay(event, overlay)) {
            dispose();
        }
    };

    const onCloseClick = (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        dispose();
    };

    document.addEventListener('keydown', onKeyDown, true);
    overlay.addEventListener('click', onOverlayClick);
    closeBtn.addEventListener('click', onCloseClick);

    return {
        root: overlay,
        isDisposed(): boolean {
            return disposed;
        },
        dispose
    };
}
