// ToolManager — owns the active edit tool for the image viewer's edit mode.
//
// Chrome-side port of
// `vscode-omni-viewer/src/templates/image/js/ImageEditMode/managers/ToolManager.js`,
// rewritten in TypeScript for issue #11.
//
// Scope (issue #11): tool state, button-active class management, listener
// fan-out, and a canvas cursor / mode hook. NO element creation, NO
// selection, NO drag-drop, NO resize, NO save — those land in #12-#15 and
// will hang off the `subscribe()` callback (or call `getActive()`) without
// having to rewrite this class.
//
// Differences from the VSCode original worth flagging:
//   - VSCode used `document.getElementById(...)` at construction time. The
//     Chrome viewer is mounted into an arbitrary host (legacy SPA), so
//     ToolManager takes a host element + an explicit registration call
//     (`registerButton`) — it never reaches into the global document.
//   - Tool name `'rectangle'` (VSCode) -> `'rect'` (issue #11 spec).
//   - Adds an explicit `'delete'` tool name so #15 can wire the trash
//     button via the same `subscribe()` channel (delete is a one-shot
//     action, not a sticky mode — see `isTransientTool()`).
//   - `subscribe()` returns an unsubscribe fn so test code (and #12-#15)
//     can clean up listeners deterministically.

/** Set of tool names the edit mode understands. */
export type ToolName = 'select' | 'text' | 'circle' | 'rect' | 'delete';

/** All sticky tools (those that affect cursor / canvas mode). */
export const STICKY_TOOLS: readonly ToolName[] = ['select', 'text', 'circle', 'rect'];

/** All tool names in declaration order — useful for iteration in tests. */
export const ALL_TOOLS: readonly ToolName[] = ['select', 'text', 'circle', 'rect', 'delete'];

/** Listener invoked whenever the active tool changes. */
export type ToolChangeListener = (tool: ToolName) => void;

/**
 * Per-tool cursor class applied to the canvas element. Kept here (next to
 * the tool list) so future issues only have one place to extend.
 *
 * The `delete` entry is intentionally absent from STICKY_TOOLS — clicking
 * the delete button is a one-shot action and does not become the canvas's
 * sticky mode. The class map only matters for sticky tools.
 */
export const TOOL_CURSOR_CLASS: Record<Exclude<ToolName, 'delete'>, string> = {
    select: 'iv-cursor-select',
    text: 'iv-cursor-text',
    circle: 'iv-cursor-crosshair',
    rect: 'iv-cursor-crosshair'
};

/** ToolManager is decoupled from the DOM at construction time. */
export interface ToolManagerOptions {
    /**
     * Optional canvas element. When supplied, ToolManager toggles
     * `iv-cursor-*` classes + `select-mode` on it as the active tool
     * changes. Future issues (#12-#15) read this canvas for hit testing.
     */
    canvas?: HTMLElement;
    /** Default tool — defaults to `'select'`. */
    initialTool?: ToolName;
}

/**
 * Manages the active editing tool. Stateless w.r.t. element/selection —
 * those live in their own managers in #13/#14.
 */
export class ToolManager {
    private currentTool: ToolName;
    private canvas: HTMLElement | undefined;
    private readonly buttons = new Map<ToolName, HTMLElement>();
    private readonly listeners = new Set<ToolChangeListener>();

    constructor(options: ToolManagerOptions = {}) {
        this.currentTool = options.initialTool ?? 'select';
        this.canvas = options.canvas;
    }

    // --- public API ------------------------------------------------------

    /**
     * Make `tool` the active sticky tool (or fire a one-shot for
     * `'delete'`). Returns silently if `tool` is unknown.
     *
     * Side effects (in order):
     *   1. Update `currentTool` (sticky tools only — `'delete'` does not
     *      replace the prior sticky tool).
     *   2. Sync `is-active` class on every registered button.
     *   3. Update canvas cursor / `select-mode` class.
     *   4. Fan out to every registered listener.
     */
    activate(tool: ToolName): void {
        if (!isToolName(tool)) {
            return;
        }
        if (!this.isTransientTool(tool)) {
            this.currentTool = tool;
        }
        this.syncButtonStates(tool);
        this.syncCanvasClasses();
        this.notifyListeners(tool);
    }

    /** Read the current sticky tool. Never returns `'delete'`. */
    getActive(): ToolName {
        return this.currentTool;
    }

    /**
     * Subscribe to tool-change events. Returns an unsubscribe fn so
     * callers can deterministically detach in `dispose()`.
     */
    subscribe(listener: ToolChangeListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Bind a DOM button to a tool. Clicking the button calls `activate(tool)`.
     * The same button can be re-registered (last write wins) so the host
     * page can rebuild its toolbar without leaking listeners — we strip the
     * previous click handler before installing a fresh one.
     */
    registerButton(tool: ToolName, button: HTMLElement): void {
        if (!isToolName(tool)) {
            return;
        }
        const previous = this.buttons.get(tool);
        if (previous && previous !== button) {
            previous.removeEventListener('click', this.makeClickHandler(tool));
        }
        this.buttons.set(tool, button);
        button.addEventListener('click', this.makeClickHandler(tool));
        // Reflect current state immediately on the freshly registered button.
        this.applyActiveClass(button, tool === this.currentTool);
    }

    /** Allow late binding of the canvas (e.g. canvas only exists once edit mode opens). */
    setCanvas(canvas: HTMLElement | undefined): void {
        this.canvas = canvas;
        this.syncCanvasClasses();
    }

    /** Reset to `'select'`. Convenience wrapper for ESC handling. */
    resetToSelect(): void {
        this.activate('select');
    }

    /** Drop all listeners. Buttons are owned by the host DOM; we don't remove them. */
    dispose(): void {
        this.listeners.clear();
        this.buttons.clear();
        this.canvas = undefined;
    }

    // --- helpers ---------------------------------------------------------

    /**
     * `'delete'` is a one-shot action, not a sticky cursor mode. Issue #15
     * will wire it: clicking the delete button must NOT replace the user's
     * current sticky tool (so they can keep drawing rectangles after a
     * delete). Hooked via `subscribe()`.
     */
    private isTransientTool(tool: ToolName): boolean {
        return tool === 'delete';
    }

    private syncButtonStates(_lastClickedTool: ToolName): void {
        for (const [tool, button] of this.buttons.entries()) {
            // Only sticky tools get `is-active` — delete button never sticks.
            if (this.isTransientTool(tool)) {
                this.applyActiveClass(button, false);
                continue;
            }
            this.applyActiveClass(button, tool === this.currentTool);
        }
    }

    private applyActiveClass(button: HTMLElement, active: boolean): void {
        button.classList.toggle('is-active', active);
    }

    private syncCanvasClasses(): void {
        const canvas = this.canvas;
        if (!canvas) return;
        // Strip every per-tool cursor class first, then apply the one for
        // the current sticky tool. Keeps the class list well-defined when
        // tools cycle.
        for (const cls of Object.values(TOOL_CURSOR_CLASS)) {
            canvas.classList.remove(cls);
        }
        const active = this.currentTool;
        if (active !== 'delete') {
            canvas.classList.add(TOOL_CURSOR_CLASS[active]);
        }
        canvas.classList.toggle('select-mode', this.currentTool === 'select');
    }

    private notifyListeners(tool: ToolName): void {
        for (const listener of this.listeners) {
            try {
                listener(tool);
            } catch (err) {
                // A misbehaving listener should not break the tool switch.
                // eslint-disable-next-line no-console
                console.error('ToolManager listener threw:', err);
            }
        }
    }

    // Each (tool) needs its own bound click handler so `registerButton`
    // can remove a stale handler when re-registering. Keep the closure
    // tiny so it can be GC'd cheaply.
    private makeClickHandler(tool: ToolName): (e: Event) => void {
        return () => this.activate(tool);
    }
}

/** Type guard — public so callers from JS land can validate before calling. */
export function isToolName(value: unknown): value is ToolName {
    return value === 'select'
        || value === 'text'
        || value === 'circle'
        || value === 'rect'
        || value === 'delete';
}
