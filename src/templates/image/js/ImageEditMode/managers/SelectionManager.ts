// SelectionManager — owns the set of currently selected element ids on the
// edit canvas.
//
// Chrome-side port of
// `vscode-omni-viewer/src/templates/image/js/ImageEditMode/managers/SelectionManager.js`,
// scoped to issue #13:
//
//   - `select(id)` / `addToSelection(id)` (toggle) / `clear()` for state
//     mutation
//   - `has(id)` / `list()` / `count()` for read access
//   - `subscribe(listener)` so DragDropManager + the host page can react to
//     selection changes (decorate DOM, update `#selectionInfo`, etc.)
//   - paints `.is-selected` on element nodes via the supplied ElementManager
//     so the visual state stays in lock-step with the data model
//
// Out of scope for #13 (deferred):
//   - resize handles + properties panel (#14)
//   - save (#15)
//
// Deliberate departures from the VSCode original:
//   - State is a `Set<string>` (ids), not an array of element objects. Ids
//     are stable (`el-<n>`) and live in ElementManager; storing references
//     would mean we have to invalidate on `clear()` etc.
//   - No DOM lookups by `document.getElementById` — we go through
//     `ElementManager.getNode(id)`, which keeps SelectionManager pure
//     w.r.t. the global DOM.
//   - Side effects (class toggling, listener fan-out) only run when the
//     selection actually changes, so subscribers don't re-render on no-ops.
//
// Constraints the tests rely on:
//   - `list()` returns ids in INSERTION order (Set preserves this in JS).
//     This matches the multi-select drag flow where the first-selected
//     element is the "anchor" used to compute drag deltas.

import type { ElementManager } from './ElementManager';

/** CSS class applied to selected element DOM nodes. */
export const SELECTED_CLASS = 'is-selected';

/** Listener invoked whenever the selection set changes. */
export type SelectionChangeListener = (selectedIds: readonly string[]) => void;

/** SelectionManager construction options. */
export interface SelectionManagerOptions {
    /**
     * The ElementManager whose nodes this manager paints `.is-selected` on.
     * Required — selection without an element store is meaningless.
     */
    elementManager: ElementManager;
}

/**
 * Owns the selection set. Pure: no global DOM queries, no module-level
 * state. Construction takes the ElementManager so the manager can resolve
 * id -> node + drop selections for ids that have been removed.
 */
export class SelectionManager {
    private readonly elementManager: ElementManager;
    private readonly selected = new Set<string>();
    private readonly listeners = new Set<SelectionChangeListener>();
    private elementSubscription: (() => void) | null = null;

    constructor(options: SelectionManagerOptions) {
        this.elementManager = options.elementManager;
        // When elements vanish (clear() / future delete), drop their ids
        // from the selection automatically. Without this, the selection
        // could outlive the elements it points at and Delete-key handlers
        // would no-op against ghost ids.
        this.elementSubscription = this.elementManager.subscribe((elements) => {
            this.pruneAgainst(elements.map((el) => el.id));
        });
    }

    // --- public API ------------------------------------------------------

    /**
     * Replace the selection with `id`. Equivalent to "click element"
     * without Shift held. Pass an unknown id to clear the selection
     * silently (mirrors the canvas-empty-click code path).
     */
    select(id: string): void {
        if (!this.elementManager.getById(id)) {
            this.clear();
            return;
        }
        // No-op: already the only selected id.
        if (this.selected.size === 1 && this.selected.has(id)) {
            return;
        }
        this.applyClass(this.list(), false);
        this.selected.clear();
        this.selected.add(id);
        this.applyClass([id], true);
        this.notify();
    }

    /**
     * Toggle membership of `id` in the selection set. Equivalent to
     * "click element" with Shift held: previously-selected ids stay,
     * `id` is added if absent, removed if present. Unknown ids are ignored.
     */
    addToSelection(id: string): void {
        if (!this.elementManager.getById(id)) {
            return;
        }
        if (this.selected.has(id)) {
            this.selected.delete(id);
            this.applyClass([id], false);
        } else {
            this.selected.add(id);
            this.applyClass([id], true);
        }
        this.notify();
    }

    /** Drop everything from the selection. No-op when already empty. */
    clear(): void {
        if (this.selected.size === 0) {
            return;
        }
        this.applyClass(this.list(), false);
        this.selected.clear();
        this.notify();
    }

    /** Whether `id` is currently selected. */
    has(id: string): boolean {
        return this.selected.has(id);
    }

    /** Snapshot of selected ids in insertion order. */
    list(): readonly string[] {
        return Array.from(this.selected);
    }

    /** Number of elements currently selected. */
    count(): number {
        return this.selected.size;
    }

    /**
     * Subscribe to selection-change events. Listener receives the
     * post-mutation list. Returns an unsubscribe fn.
     */
    subscribe(listener: SelectionChangeListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Drop listeners + detach from ElementManager. Mirrors ToolManager.dispose(). */
    dispose(): void {
        if (this.elementSubscription) {
            this.elementSubscription();
            this.elementSubscription = null;
        }
        // Don't bother stripping `.is-selected` from element nodes — the
        // ElementManager owns the lifetime of those nodes; if it's been
        // disposed the nodes are gone, and if it hasn't, the host can
        // re-mount selection if needed.
        this.selected.clear();
        this.listeners.clear();
    }

    // --- helpers ---------------------------------------------------------

    /** Drop any selected ids no longer present in `livingIds`. */
    private pruneAgainst(livingIds: readonly string[]): void {
        if (this.selected.size === 0) return;
        const living = new Set(livingIds);
        let changed = false;
        for (const id of Array.from(this.selected)) {
            if (!living.has(id)) {
                this.selected.delete(id);
                changed = true;
            }
        }
        if (changed) {
            this.notify();
        }
    }

    /** Toggle `.is-selected` on the DOM nodes for the given ids. */
    private applyClass(ids: readonly string[], on: boolean): void {
        for (const id of ids) {
            const node = this.elementManager.getNode(id);
            if (node) {
                node.classList.toggle(SELECTED_CLASS, on);
            }
        }
    }

    private notify(): void {
        const snapshot = this.list();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch (err) {
                // A misbehaving listener should not break the selection.
                // eslint-disable-next-line no-console
                console.error('SelectionManager listener threw:', err);
            }
        }
    }
}
