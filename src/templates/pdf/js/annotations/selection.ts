// Selection / drag / delete manager for the Chrome PDF viewer (issue #21).
//
// Lifecycle owned here:
//   - "Selection mode" is the default — it's active whenever neither the
//     text mode (#19) nor the signature mode (#20) is on. The host calls
//     `enable()` / `disable()` from its mutual-exclusion logic; while
//     disabled, this module ignores all pointer / keyboard events.
//   - Click on a `.pv-annotation-text` or `.pv-annotation-signature` →
//     select it (one annotation at a time). The selected DOM node gets
//     `.pv-annotation-selected`.
//   - Mousedown on the selected annotation + drag → translate via
//     mousemove. On mouseup, commit the new x/y to the store via
//     `updateAnnotation(id, {x, y})`. Screen-px deltas are converted back
//     to PDF points using `screenDelta / scale` (inverse of #19's model).
//   - `Delete` / `Backspace` (when not focused inside an input) removes
//     the selected annotation. `Esc` clears the selection.
//   - Right-click on an annotation → minimal context menu with a
//     "Delete" option.
//
// Pure helpers (`screenDeltaToPdfPoints`, `dragReducer`,
// `isAnnotationTarget`) carry the math + state machine and are exported
// for unit tests.

import { PdfAnnotationStore } from '../pdfAnnotationStore';

/** CSS class applied to the currently-selected overlay node. */
export const SELECTED_CLASS = 'pv-annotation-selected';

/**
 * CSS selector matching every overlay annotation kind we support
 * selecting. Keep in sync with `annotations/text.ts` /
 * `annotations/signature.ts`.
 */
export const ANNOTATION_NODE_SELECTOR =
    '.pv-annotation-text, .pv-annotation-signature';

/**
 * Pure helper: convert a screen-px delta back into a PDF-point delta at a
 * given pdf.js scale. Mirrors `screenPxToPdfPoint` but without the
 * "scale=0 → 0" guard's dependency on absolute coordinates: we just
 * divide. Exported so the math has unit tests.
 */
export function screenDeltaToPdfPoints(
    deltaX: number,
    deltaY: number,
    scale: number
): { dx: number; dy: number } {
    if (!scale) return { dx: 0, dy: 0 };
    return { dx: deltaX / scale, dy: deltaY / scale };
}

/**
 * Pure helper: returns the annotation id from a DOM element, or
 * `undefined` if `target` is not an annotation node (or descendant).
 * Used by both the click + context-menu paths.
 */
export function isAnnotationTarget(
    target: EventTarget | null
): { id: string; node: HTMLElement } | undefined {
    if (!target) return undefined;
    if (!(target instanceof Element)) return undefined;
    const node = target.closest<HTMLElement>(ANNOTATION_NODE_SELECTOR);
    if (!node) return undefined;
    const id = node.dataset.annotationId;
    if (!id) return undefined;
    return { id, node };
}

/**
 * Drag state machine:
 *   idle  --(begin)-->  dragging  --(move)-->  dragging  --(commit | cancel)-->  idle
 */
export type DragState =
    | { status: 'idle' }
    | {
          status: 'dragging';
          id: string;
          /** Anchor (annotation x/y in PDF points at drag start). */
          startX: number;
          startY: number;
          /** Pointer screen position at drag start. */
          pointerStartX: number;
          pointerStartY: number;
          /** Current PDF-point coords during the drag (live). */
          currentX: number;
          currentY: number;
      };

export type DragAction =
    | {
          type: 'begin';
          id: string;
          startX: number;
          startY: number;
          pointerStartX: number;
          pointerStartY: number;
      }
    | { type: 'move'; pointerX: number; pointerY: number; scale: number }
    | { type: 'commit' }
    | { type: 'cancel' };

/**
 * Pure reducer for the drag state machine. The host wires actual pointer
 * events to dispatches against this reducer; tests can drive it directly
 * to validate state transitions without touching the DOM.
 */
export function dragReducer(state: DragState, action: DragAction): DragState {
    switch (action.type) {
        case 'begin':
            return {
                status: 'dragging',
                id: action.id,
                startX: action.startX,
                startY: action.startY,
                pointerStartX: action.pointerStartX,
                pointerStartY: action.pointerStartY,
                currentX: action.startX,
                currentY: action.startY
            };
        case 'move': {
            if (state.status !== 'dragging') return state;
            const { dx, dy } = screenDeltaToPdfPoints(
                action.pointerX - state.pointerStartX,
                action.pointerY - state.pointerStartY,
                action.scale
            );
            return {
                ...state,
                currentX: state.startX + dx,
                currentY: state.startY + dy
            };
        }
        case 'commit':
        case 'cancel':
            return { status: 'idle' };
        default:
            return state;
    }
}

/**
 * Pure helper: returns true when keyboard input should be ignored because
 * it originated inside a text-entry control. Keeps `Delete` / `Backspace`
 * from nuking the selected annotation while the user is editing in the
 * password input or the text-annotation textarea.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
    if (!target) return false;
    if (!(target instanceof Element)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    const html = target as HTMLElement;
    if (html.isContentEditable) return true;
    return false;
}

export interface SelectionLayerOptions {
    /** Annotation store; selection commits patches via `updateAnnotation`. */
    store: PdfAnnotationStore;
    /** `#pv-overlayLayer` — selection listens on this, plus document. */
    overlayLayer: HTMLElement;
    /** Returns the renderer's current pdf.js scale (1.0 == 100%). */
    getCurrentScale(): number;
    /**
     * Optional: notified after the selection changes (id or null). Useful
     * for the host to flip a CSS class on the selection toolbar etc.
     */
    onSelectionChanged?(id: string | undefined): void;
}

export interface SelectionHandle {
    /** Currently-selected annotation id, or `undefined`. */
    getSelectedId(): string | undefined;
    /** Programmatically clear the selection (mirrors Esc). */
    clearSelection(): void;
    /** Re-apply `.pv-annotation-selected` after the overlay was repainted. */
    refresh(): void;
    /** True when this layer is currently listening for events. */
    isEnabled(): boolean;
    /** Start listening for events (default after `attachSelectionLayer`). */
    enable(): void;
    /** Stop listening + drop the selection (used while text/signature mode is on). */
    disable(): void;
    /** Tear down every listener attached to the document / overlay. */
    dispose(): void;
}

/**
 * Wire the selection / drag / delete manager onto `overlayLayer`. Returns
 * a handle the host drives from its mode-toggle code paths.
 */
export function attachSelectionLayer(
    opts: SelectionLayerOptions
): SelectionHandle {
    const { store, overlayLayer, getCurrentScale } = opts;
    let enabled = true;
    let selectedId: string | undefined;
    let drag: DragState = { status: 'idle' };
    /**
     * Per-drag bookkeeping that doesn't belong in the pure reducer state:
     * a snapshot of the live overlay's transform offsets so we can paint
     * the dragged node in real time without going through the store.
     */
    let dragNode: HTMLElement | undefined;
    let dragInitialLeft = 0;
    let dragInitialTop = 0;
    /** Suppress the very next click after a drag (so mouseup→click doesn't deselect). */
    let suppressNextClick = false;

    const setSelection = (next: string | undefined): void => {
        if (selectedId === next) return;
        selectedId = next;
        applySelectionClass();
        opts.onSelectionChanged?.(next);
    };

    const findNodeById = (id: string): HTMLElement | undefined => {
        const node = overlayLayer.querySelector<HTMLElement>(
            `[data-annotation-id="${cssEscape(id)}"]`
        );
        return node ?? undefined;
    };

    const applySelectionClass = (): void => {
        // Drop the class everywhere first so a stale node from a previous
        // repaint doesn't keep its highlight.
        const stale = overlayLayer.querySelectorAll(`.${SELECTED_CLASS}`);
        stale.forEach((el) => el.classList.remove(SELECTED_CLASS));
        if (!selectedId) return;
        const node = findNodeById(selectedId);
        if (node) node.classList.add(SELECTED_CLASS);
    };

    const dismissContextMenu = (): void => {
        if (!contextMenuEl) return;
        contextMenuEl.remove();
        contextMenuEl = undefined;
    };

    let contextMenuEl: HTMLElement | undefined;

    const showContextMenu = (clientX: number, clientY: number, id: string): void => {
        dismissContextMenu();
        const menu = document.createElement('div');
        menu.className = 'pv-annotation-context-menu';
        menu.style.position = 'fixed';
        menu.style.left = `${clientX}px`;
        menu.style.top = `${clientY}px`;
        menu.style.zIndex = '1100';

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'pv-annotation-context-item';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            dismissContextMenu();
            store.removeAnnotation(id);
            if (selectedId === id) setSelection(undefined);
        });
        menu.appendChild(deleteBtn);

        document.body.appendChild(menu);
        contextMenuEl = menu;
    };

    const onMouseDown = (event: MouseEvent): void => {
        if (!enabled) return;
        if (event.button !== 0) return;
        const hit = isAnnotationTarget(event.target);
        if (!hit) {
            // Click on empty overlay area → clear selection.
            if (selectedId) setSelection(undefined);
            return;
        }
        // Always select the clicked annotation first.
        setSelection(hit.id);

        const annotation = store.getAnnotation(hit.id);
        if (!annotation) return;

        dragNode = hit.node;
        // Snapshot the node's current visual offsets so we can paint the
        // drag preview without recomputing the projection every move.
        dragInitialLeft = parseFloat(dragNode.style.left) || 0;
        dragInitialTop = parseFloat(dragNode.style.top) || 0;
        drag = dragReducer(drag, {
            type: 'begin',
            id: hit.id,
            startX: annotation.x,
            startY: annotation.y,
            pointerStartX: event.clientX,
            pointerStartY: event.clientY
        });

        event.preventDefault();
        event.stopPropagation();

        document.addEventListener('mousemove', onDocumentMouseMove, true);
        document.addEventListener('mouseup', onDocumentMouseUp, true);
    };

    const onDocumentMouseMove = (event: MouseEvent): void => {
        if (drag.status !== 'dragging') return;
        const scale = getCurrentScale();
        drag = dragReducer(drag, {
            type: 'move',
            pointerX: event.clientX,
            pointerY: event.clientY,
            scale
        });
        if (dragNode) {
            // Move the live DOM node by the screen-px delta. The overlay
            // is repainted on commit so this is purely a visual preview.
            const screenDx = event.clientX - getDragPointerStart(drag).x;
            const screenDy = event.clientY - getDragPointerStart(drag).y;
            dragNode.style.left = `${dragInitialLeft + screenDx}px`;
            dragNode.style.top = `${dragInitialTop + screenDy}px`;
        }
    };

    const onDocumentMouseUp = (event: MouseEvent): void => {
        document.removeEventListener('mousemove', onDocumentMouseMove, true);
        document.removeEventListener('mouseup', onDocumentMouseUp, true);
        if (drag.status !== 'dragging') {
            return;
        }
        const scale = getCurrentScale();
        const movedX = (event.clientX - drag.pointerStartX) / (scale || 1);
        const movedY = (event.clientY - drag.pointerStartY) / (scale || 1);
        const id = drag.id;
        const finalX = drag.startX + movedX;
        const finalY = drag.startY + movedY;
        // Suppress the synthetic click that follows a mouseup if we
        // actually moved (otherwise the click handler would re-process
        // selection and could deselect on mouseup-on-empty-area).
        if (Math.abs(event.clientX - drag.pointerStartX) > 1 ||
            Math.abs(event.clientY - drag.pointerStartY) > 1) {
            suppressNextClick = true;
            store.updateAnnotation(id, { x: finalX, y: finalY });
        }
        drag = dragReducer(drag, { type: 'commit' });
        dragNode = undefined;
    };

    const onClick = (event: MouseEvent): void => {
        if (!enabled) return;
        if (suppressNextClick) {
            suppressNextClick = false;
            event.stopPropagation();
            return;
        }
    };

    const onContextMenu = (event: MouseEvent): void => {
        if (!enabled) return;
        const hit = isAnnotationTarget(event.target);
        if (!hit) return;
        event.preventDefault();
        event.stopPropagation();
        setSelection(hit.id);
        showContextMenu(event.clientX, event.clientY, hit.id);
    };

    const onDocumentClickToDismissMenu = (event: MouseEvent): void => {
        if (!contextMenuEl) return;
        if (event.target instanceof Node && contextMenuEl.contains(event.target)) {
            return;
        }
        dismissContextMenu();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (!enabled) return;
        if (!selectedId) return;
        if (isEditableTarget(event.target)) return;
        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            const id = selectedId;
            setSelection(undefined);
            store.removeAnnotation(id);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setSelection(undefined);
            dismissContextMenu();
        }
    };

    overlayLayer.addEventListener('mousedown', onMouseDown);
    overlayLayer.addEventListener('click', onClick, true);
    overlayLayer.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onDocumentClickToDismissMenu, true);

    // Re-apply selection class whenever the store mutates (overlay is
    // wiped + repainted by the host on every change).
    const unsubStore = store.onChange(() => {
        applySelectionClass();
    });

    return {
        getSelectedId(): string | undefined {
            return selectedId;
        },
        clearSelection(): void {
            setSelection(undefined);
        },
        refresh(): void {
            applySelectionClass();
        },
        isEnabled(): boolean {
            return enabled;
        },
        enable(): void {
            enabled = true;
        },
        disable(): void {
            enabled = false;
            setSelection(undefined);
            dismissContextMenu();
        },
        dispose(): void {
            overlayLayer.removeEventListener('mousedown', onMouseDown);
            overlayLayer.removeEventListener('click', onClick, true);
            overlayLayer.removeEventListener('contextmenu', onContextMenu);
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('mousedown', onDocumentClickToDismissMenu, true);
            document.removeEventListener('mousemove', onDocumentMouseMove, true);
            document.removeEventListener('mouseup', onDocumentMouseUp, true);
            try {
                unsubStore();
            } catch {
                // best-effort
            }
            dismissContextMenu();
            enabled = false;
            selectedId = undefined;
            drag = { status: 'idle' };
        }
    };
}

/** Tiny helper for `[data-annotation-id="…"]` lookups. */
function cssEscape(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(value);
    }
    return value.replace(/["\\]/g, '\\$&');
}

/** Internal helper to read the pointer-start coords back out of the drag state. */
function getDragPointerStart(state: DragState): { x: number; y: number } {
    if (state.status === 'dragging') {
        return { x: state.pointerStartX, y: state.pointerStartY };
    }
    return { x: 0, y: 0 };
}
