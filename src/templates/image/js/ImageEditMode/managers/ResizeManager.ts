// ResizeManager — attaches eight directional resize handles to the
// currently single-selected element and translates pointer drags into
// (x, y, w, h) updates routed through the ElementManager.
//
// Chrome-side port of `vscode-omni-viewer/.../ResizeManager.js`, scoped to
// issue #14:
//   - 8 handles (n / s / e / w / ne / nw / se / sw) painted at the corners
//     and midpoints of the element's bounding box.
//   - mousedown -> mousemove on `document` -> compute new box -> push
//     update to ElementManager.update(id, { x, y, w, h }).
//   - Handles only render when SelectionManager has exactly one entry. The
//     orchestrator (`index.ts`) is responsible for hiding the panel +
//     handles when the count is 0 or > 1.
//   - Min size clamp: 12 px on both axes (prevents zero/inverted boxes;
//     matches the spec in issue #14).
//
// The math is split into a pure helper (`applyResize`) so it can be unit
// tested without DOM. The class composes that helper and owns DOM listener
// lifetimes.
//
// Notes worth flagging:
//   - The wrapper element is centered on (x, y) via `translate(-50%, -50%)`
//     (see ElementManager `applyBaseStyles`). The resize math here is
//     written in terms of that center: when the user drags the SE handle
//     by (dx, dy) the right edge gains dx -> width grows by dx and the
//     center moves by dx/2. Same logic for the other directions; pure
//     algebra, no special-casing needed.
//   - Handles live INSIDE the element wrapper so they inherit the same
//     translate(-50%) origin. We use absolute positioning at the four
//     corners + four edge midpoints with a fixed handle size (8 px).

import type { ElementManager } from './ElementManager';
import type { SelectionManager } from './SelectionManager';
import type { ToolManager } from './ToolManager';

/** Compass direction encoding the eight resize handles. */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** All eight handles, in the order they're rendered. */
export const ALL_HANDLES: readonly ResizeHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** Default minimum size on both axes — applied by `applyResize` and the resize loop. */
export const DEFAULT_MIN_SIZE = 12;

/** Pure axis-aligned bounding box (centered on x, y per `applyBaseStyles`). */
export interface ResizeBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** CSS class applied to every handle DOM node. */
export const RESIZE_HANDLE_CLASS = 'iv-resize-handle';

/** Per-handle CSS modifier so styles can pick a cursor / position. */
export const RESIZE_HANDLE_DIR_CLASS: Record<ResizeHandle, string> = {
    n: 'iv-resize-handle--n',
    s: 'iv-resize-handle--s',
    e: 'iv-resize-handle--e',
    w: 'iv-resize-handle--w',
    ne: 'iv-resize-handle--ne',
    nw: 'iv-resize-handle--nw',
    se: 'iv-resize-handle--se',
    sw: 'iv-resize-handle--sw'
};

/**
 * Pure resize math. Given the starting box, the handle being dragged, the
 * pointer delta in client px, and a min-size clamp, returns the new box.
 *
 * The element wrapper is centered on (x, y). For each handle we rewrite
 * the new box in terms of "fixed edge" + "moving edge" and recompute the
 * center as the midpoint:
 *
 *   se handle: left edge fixed at (x - w/2). New w = w + dx.
 *              right edge moves to (x - w/2 + new_w).
 *              Center x' = (left + new_right) / 2 = x + dx/2.
 *
 * Symmetric for the other directions. All eight handles are derived this
 * way. The min-size clamp pins the moving edge so the fixed edge stays
 * stationary even when the user drags past zero.
 */
export function applyResize(
    box: ResizeBox,
    handle: ResizeHandle,
    deltaX: number,
    deltaY: number,
    minSize: number = DEFAULT_MIN_SIZE
): ResizeBox {
    const min = Math.max(1, minSize);

    const startLeft = box.x - box.w / 2;
    const startRight = box.x + box.w / 2;
    const startTop = box.y - box.h / 2;
    const startBottom = box.y + box.h / 2;

    let left = startLeft;
    let right = startRight;
    let top = startTop;
    let bottom = startBottom;

    // Horizontal edge motion.
    if (handle === 'e' || handle === 'ne' || handle === 'se') {
        right = Math.max(startLeft + min, startRight + deltaX);
    } else if (handle === 'w' || handle === 'nw' || handle === 'sw') {
        left = Math.min(startRight - min, startLeft + deltaX);
    }

    // Vertical edge motion.
    if (handle === 's' || handle === 'se' || handle === 'sw') {
        bottom = Math.max(startTop + min, startBottom + deltaY);
    } else if (handle === 'n' || handle === 'ne' || handle === 'nw') {
        top = Math.min(startBottom - min, startTop + deltaY);
    }

    const w = right - left;
    const h = bottom - top;
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;

    return { x, y, w, h };
}

/** Construction options for ResizeManager. */
export interface ResizeManagerOptions {
    elementManager: ElementManager;
    selectionManager: SelectionManager;
    toolManager: ToolManager;
    /** Min size clamp (default 12 px). */
    minSize?: number;
}

/**
 * Owns the eight resize handles + the resize-drag loop. Pure w.r.t.
 * globals — all listeners are detached on `dispose()`.
 */
export class ResizeManager {
    private readonly elementManager: ElementManager;
    private readonly selectionManager: SelectionManager;
    private readonly toolManager: ToolManager;
    private readonly minSize: number;

    private readonly handlesByElementId = new Map<string, HTMLElement[]>();

    private isResizing = false;
    private currentElementId: string | null = null;
    private currentHandle: ResizeHandle | null = null;
    private startBox: ResizeBox = { x: 0, y: 0, w: 0, h: 0 };
    private startClientX = 0;
    private startClientY = 0;

    private readonly selectionUnsubscribe: () => void;
    private readonly elementUnsubscribe: () => void;

    constructor(options: ResizeManagerOptions) {
        this.elementManager = options.elementManager;
        this.selectionManager = options.selectionManager;
        this.toolManager = options.toolManager;
        this.minSize = options.minSize ?? DEFAULT_MIN_SIZE;

        this.selectionUnsubscribe = this.selectionManager.subscribe((ids) => {
            this.syncToSelection(ids);
        });
        // Re-sync when the element list changes (deletes etc.) — handles for
        // a vanished element must come down with their wrapper.
        this.elementUnsubscribe = this.elementManager.subscribe(() => {
            this.syncToSelection(this.selectionManager.list());
        });
        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('mouseup', this.onMouseUp);
    }

    /** Whether a resize drag is currently in flight. */
    isResizingActive(): boolean {
        return this.isResizing;
    }

    /** Visible handle DOM nodes for the given element id (test helper). */
    getHandles(elementId: string): readonly HTMLElement[] {
        return this.handlesByElementId.get(elementId) ?? [];
    }

    /** Detach listeners + remove every handle DOM node. */
    dispose(): void {
        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('mouseup', this.onMouseUp);
        this.selectionUnsubscribe();
        this.elementUnsubscribe();
        this.removeAllHandles();
        this.isResizing = false;
        this.currentElementId = null;
        this.currentHandle = null;
    }

    // --- internals -------------------------------------------------------

    /**
     * Reflect the current selection on the DOM:
     *   - Exactly one selected id -> ensure handles exist on its wrapper.
     *   - Otherwise -> remove every handle from every wrapper.
     */
    private syncToSelection(ids: readonly string[]): void {
        if (ids.length !== 1) {
            this.removeAllHandles();
            return;
        }
        const id = ids[0];
        // Drop handles for any other element first (defensive — a previous
        // selection might still own its handles if the listener fired out of
        // order during an in-flight mutation).
        for (const otherId of Array.from(this.handlesByElementId.keys())) {
            if (otherId !== id) {
                this.removeHandlesFor(otherId);
            }
        }
        if (!this.handlesByElementId.has(id)) {
            this.attachHandles(id);
        }
    }

    private attachHandles(id: string): void {
        const node = this.elementManager.getNode(id);
        if (!node) return;

        const handles: HTMLElement[] = [];
        for (const dir of ALL_HANDLES) {
            const handle = document.createElement('div');
            handle.className = `${RESIZE_HANDLE_CLASS} ${RESIZE_HANDLE_DIR_CLASS[dir]}`;
            handle.dataset.handle = dir;
            handle.dataset.elementId = id;
            handle.addEventListener('mousedown', this.onHandleMouseDown);
            node.appendChild(handle);
            handles.push(handle);
        }
        this.handlesByElementId.set(id, handles);
    }

    private removeHandlesFor(id: string): void {
        const handles = this.handlesByElementId.get(id);
        if (!handles) return;
        for (const handle of handles) {
            handle.removeEventListener('mousedown', this.onHandleMouseDown);
            if (handle.parentElement) {
                handle.parentElement.removeChild(handle);
            }
        }
        this.handlesByElementId.delete(id);
    }

    private removeAllHandles(): void {
        for (const id of Array.from(this.handlesByElementId.keys())) {
            this.removeHandlesFor(id);
        }
    }

    // --- pointer plumbing ------------------------------------------------

    private readonly onHandleMouseDown = (e: MouseEvent): void => {
        if (e.button !== 0) return;
        // Resize is only meaningful with the select tool active. Other tools
        // own canvas clicks (text/circle/rect create elements; #15 hooks
        // delete). Bail silently — the handles aren't visible in those
        // modes anyway in normal usage but defense-in-depth helps tests.
        if (this.toolManager.getActive() !== 'select') return;

        const target = e.currentTarget as HTMLElement | null;
        if (!target) return;
        const dir = target.dataset.handle as ResizeHandle | undefined;
        const id = target.dataset.elementId;
        if (!dir || !id) return;

        const data = this.elementManager.getById(id);
        if (!data) return;

        this.isResizing = true;
        this.currentElementId = id;
        this.currentHandle = dir;
        this.startBox = { x: data.x, y: data.y, w: data.w, h: data.h };
        this.startClientX = e.clientX;
        this.startClientY = e.clientY;

        // Stop the event so DragDropManager (mousedown on the wrapper) does
        // NOT also begin a drag. Without this, a single drag would resize
        // AND translate the element.
        e.preventDefault();
        e.stopPropagation();
    };

    private readonly onMouseMove = (e: MouseEvent): void => {
        if (!this.isResizing || !this.currentElementId || !this.currentHandle) return;
        const deltaX = e.clientX - this.startClientX;
        const deltaY = e.clientY - this.startClientY;
        const next = applyResize(this.startBox, this.currentHandle, deltaX, deltaY, this.minSize);
        this.elementManager.update(this.currentElementId, {
            x: next.x,
            y: next.y,
            w: next.w,
            h: next.h
        });
    };

    private readonly onMouseUp = (_e: MouseEvent): void => {
        if (!this.isResizing) return;
        this.isResizing = false;
        this.currentElementId = null;
        this.currentHandle = null;
    };
}
