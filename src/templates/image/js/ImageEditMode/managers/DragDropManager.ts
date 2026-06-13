// DragDropManager — translates the selected element(s) on mousemove while
// the mouse button is held over a selected element.
//
// Chrome-side port of
// `vscode-omni-viewer/src/templates/image/js/ImageEditMode/managers/DragDropManager.js`,
// scoped to issue #13:
//
//   - Listens for `mousedown` on the edit canvas + every element node and
//     hit-tests through `data-element-id`.
//   - On mousedown over a SELECTED element, captures the per-element
//     starting positions and registers `mousemove` / `mouseup` on
//     `document` so drags continue even when the cursor leaves the canvas.
//   - On mousemove, computes a single (deltaX, deltaY) from the pointer
//     and applies it to every selected element's stored (x, y) plus its
//     DOM node's inline `left` / `top`.
//   - Mousedown on an UN-selected element selects it via SelectionManager
//     (single-select; Shift held -> multi-toggle), then arms a drag of
//     that element so a press-and-drag without an explicit prior click
//     still works.
//   - Mousedown on the empty canvas clears the selection.
//
// Out of scope for #13:
//   - resize handles + properties panel (#14)
//   - save (#15)
//
// Drag math (used by tests and worth pinning down):
//
//   On mousedown:
//     anchorClientX = e.clientX
//     anchorClientY = e.clientY
//     for each selected element id:
//       initialPositions[id] = { x: el.x, y: el.y }
//
//   On mousemove:
//     deltaX = e.clientX - anchorClientX
//     deltaY = e.clientY - anchorClientY
//     for each selected element id:
//       el.x = initialPositions[id].x + deltaX
//       el.y = initialPositions[id].y + deltaY
//       update node.style.left / top
//
// This formulation is robust to multi-select (every element is moved by the
// same delta), to canvases that are scrolled/transformed (we use clientX/Y
// throughout — the canvas-local origin cancels out), and to no-op moves
// (delta of 0,0 produces no DOM writes). It MUST stay in sync with the
// `applyBaseStyles` contract in ElementManager: nodes are positioned via
// `style.left` / `style.top` plus a `translate(-50%, -50%)` transform that
// centers them on (x, y).

import type { ElementManager, ElementData } from './ElementManager';
import type { ToolManager } from './ToolManager';
import type { SelectionManager } from './SelectionManager';

/** Construction options for DragDropManager. */
export interface DragDropManagerOptions {
    /** Edit canvas — mousedown source for hit-testing + empty-click. */
    canvas: HTMLElement;
    /** Element store. */
    elementManager: ElementManager;
    /** Selection store. */
    selectionManager: SelectionManager;
    /** Tool store — drag is only active when the current tool is `'select'`. */
    toolManager: ToolManager;
}

/** Plain (x, y) pair — the stored position of an element at drag start. */
interface InitialPosition {
    x: number;
    y: number;
}

/**
 * Wires drag-to-move behaviour onto the edit canvas. Pure w.r.t. globals:
 * all DOM listeners are scoped to `canvas` + `document` and are removed in
 * `dispose()`.
 */
export class DragDropManager {
    private readonly canvas: HTMLElement;
    private readonly elementManager: ElementManager;
    private readonly selectionManager: SelectionManager;
    private readonly toolManager: ToolManager;

    private isDragging = false;
    private anchorClientX = 0;
    private anchorClientY = 0;
    private dragMoved = false;
    private initialPositions = new Map<string, InitialPosition>();

    constructor(options: DragDropManagerOptions) {
        this.canvas = options.canvas;
        this.elementManager = options.elementManager;
        this.selectionManager = options.selectionManager;
        this.toolManager = options.toolManager;

        this.canvas.addEventListener('mousedown', this.onMouseDown);
        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('mouseup', this.onMouseUp);
    }

    // --- public API ------------------------------------------------------

    /** Whether a drag operation is currently in flight. */
    isDraggingActive(): boolean {
        return this.isDragging;
    }

    /** Detach DOM listeners. */
    dispose(): void {
        this.canvas.removeEventListener('mousedown', this.onMouseDown);
        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('mouseup', this.onMouseUp);
        this.initialPositions.clear();
        this.isDragging = false;
        this.dragMoved = false;
    }

    /**
     * Hit-test helper — returns the element id under `target`, or null if
     * the target isn't inside an editable element. Exposed for tests; the
     * mousedown handler uses it internally.
     */
    findElementIdFromTarget(target: EventTarget | null): string | null {
        if (!(target instanceof Element)) return null;
        const node = target.closest('[data-element-id]');
        if (!(node instanceof HTMLElement)) return null;
        const id = node.dataset.elementId;
        return id ?? null;
    }

    // --- handlers --------------------------------------------------------

    /**
     * Mousedown router. Three branches:
     *   (a) Target is an editable element AND already selected -> begin drag.
     *   (b) Target is an editable element AND NOT selected -> update
     *       selection (single or multi via Shift) AND prime a drag of the
     *       new selection so press-and-drag-without-click works.
     *   (c) Target is the empty canvas -> clear selection.
     */
    private readonly onMouseDown = (e: MouseEvent): void => {
        // Only the select tool drives drag/selection. Other tools (text,
        // circle, rect) own canvas clicks for element creation in
        // `index.ts`; #14 will own resize for the same target.
        if (this.toolManager.getActive() !== 'select') {
            return;
        }
        // Ignore non-primary buttons.
        if (e.button !== 0) {
            return;
        }

        const id = this.findElementIdFromTarget(e.target);
        if (!id) {
            // Click on bare canvas -> deselect all. We only treat clicks
            // landing directly on the canvas as "empty"; clicks on stray
            // non-element children (none today, but #14 may add some) are
            // ignored entirely so we don't accidentally clear.
            if (e.target === this.canvas) {
                this.selectionManager.clear();
            }
            return;
        }

        const isShift = e.shiftKey;
        if (!this.selectionManager.has(id)) {
            // Branch (b): bring this element into the selection FIRST so
            // the prime-drag step picks it up. Shift toggles vs replace.
            if (isShift) {
                this.selectionManager.addToSelection(id);
            } else {
                this.selectionManager.select(id);
            }
        } else if (isShift) {
            // Already selected + Shift held -> toggle off. We do NOT
            // arm a drag in this case — the user explicitly removed
            // the element from the selection.
            this.selectionManager.addToSelection(id);
            return;
        }

        // Don't begin a drag if the selection ended up empty (paranoia
        // against future SelectionManager changes).
        if (this.selectionManager.count() === 0) {
            return;
        }

        this.beginDrag(e);
        e.preventDefault();
    };

    private readonly onMouseMove = (e: MouseEvent): void => {
        if (!this.isDragging) return;
        const deltaX = e.clientX - this.anchorClientX;
        const deltaY = e.clientY - this.anchorClientY;
        if (deltaX === 0 && deltaY === 0) {
            return;
        }
        this.dragMoved = true;
        this.applyDelta(deltaX, deltaY);
    };

    private readonly onMouseUp = (_e: MouseEvent): void => {
        if (!this.isDragging) return;
        this.isDragging = false;
        this.dragMoved = false;
        this.initialPositions.clear();
    };

    // --- drag plumbing ---------------------------------------------------

    private beginDrag(e: MouseEvent): void {
        this.isDragging = true;
        this.dragMoved = false;
        this.anchorClientX = e.clientX;
        this.anchorClientY = e.clientY;
        this.initialPositions.clear();
        for (const id of this.selectionManager.list()) {
            const data = this.elementManager.getById(id);
            if (data) {
                this.initialPositions.set(id, { x: data.x, y: data.y });
            }
        }
    }

    /**
     * Apply (deltaX, deltaY) to every selected element's stored position
     * + its DOM node's inline left/top. Mutates `ElementData` in place —
     * `ElementManager.list()` returns the same object instances we
     * received via `getById`, so future `serialize()` snapshots see the
     * post-drag coordinates.
     */
    private applyDelta(deltaX: number, deltaY: number): void {
        for (const [id, initial] of this.initialPositions.entries()) {
            const data = this.elementManager.getById(id);
            if (!data) continue;
            const newX = initial.x + deltaX;
            const newY = initial.y + deltaY;
            updateElementPosition(data, this.elementManager.getNode(id), newX, newY);
        }
    }
}

/**
 * Mutate `data.x / y` and reflect the new position on `node`'s inline
 * styles. Exported for tests + future managers (#14 resize will reuse it).
 */
export function updateElementPosition(
    data: ElementData,
    node: HTMLElement | undefined,
    newX: number,
    newY: number
): void {
    data.x = newX;
    data.y = newY;
    if (node) {
        node.style.left = `${newX}px`;
        node.style.top = `${newY}px`;
    }
}
