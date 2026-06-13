// ImageEditMode orchestrator.
//
// Chrome-side port of
// `vscode-omni-viewer/src/templates/image/js/ImageEditMode/index.js`,
// covering issues #11 (panel/ToolManager skeleton), #12 (canvas + element
// creation), and #13 (selection + drag-drop):
//
//   - mount/unmount the edit-mode panel (`.iv-edit-controls`)
//   - own a `ToolManager` and wire the panel's 5 tool buttons to it
//   - own an `ElementManager` and create elements on canvas-click for the
//     text / circle / rect tools (#12)
//   - own a `SelectionManager` + `DragDropManager` and wire mouse/keyboard
//     for click-to-select, Shift-click multi-select, drag-to-move, and
//     Delete/Backspace + #deleteSelected button removal (#13)
//   - hide/show the panel as edit mode toggles
//   - handle the global ESC key (return to select tool while in edit mode)
//
// Out of scope (deferred):
//   - resize handles + properties panel (#14)
//   - save (#15)

import { ToolManager, ToolName, ALL_TOOLS } from './managers/ToolManager';
import { ElementManager, ElementType, ElementData } from './managers/ElementManager';
import { SelectionManager } from './managers/SelectionManager';
import { DragDropManager } from './managers/DragDropManager';
import { ResizeManager } from './managers/ResizeManager';
import { mountPropertiesPanel, PropertiesPanelHandle } from './managers/PropertiesPanel';
import { createDiv, createButton, setVisible } from './utils/DOMUtils';

/**
 * Caller-supplied options for `mountImageEditMode`.
 */
export interface MountImageEditModeOptions {
    /**
     * Host element the edit-mode panel is appended to. Typically the
     * image viewer's main content container so the panel sits inline
     * with the other toolbars.
     */
    host: HTMLElement;
    /**
     * Optional canvas element handed to the ToolManager so it can drive
     * cursor classes. When supplied, the ElementManager mounts its created
     * elements onto this canvas. When omitted, `mountImageEditMode` builds
     * its own `.iv-edit-canvas` overlay child (the common case in tests +
     * the live viewer alike).
     */
    canvas?: HTMLElement;
    /**
     * Optional host for the auto-built edit canvas. When `canvas` is also
     * omitted, the manager still creates a canvas and parents it to this
     * element (typically the image wrapper) so clicks on the edit canvas
     * line up with the image. Defaults to `host` if omitted.
     */
    canvasHost?: HTMLElement;
    /**
     * Called whenever the panel is shown (`true`) or hidden (`false`).
     * Lets the host page reflect edit-mode state on the toggle button.
     */
    onToggle?: (enabled: boolean) => void;
    /**
     * Called whenever a tool is activated. #12-#15 wire onto this.
     * Equivalent to `toolManager.subscribe(...)` but exposed on the
     * mount handle for convenience.
     */
    onToolActivate?: (tool: ToolName) => void;
    /**
     * Called whenever an element is created via the canvas-click handler.
     * #14 (properties panel) + #15 (save) hook onto this; tests use it to
     * assert the canvas-click path runs.
     */
    onElementCreate?: (element: ElementData) => void;
    /**
     * Called whenever the selection changes (issue #13). Receives the
     * post-mutation list of selected element ids. Equivalent to
     * `selectionManager.subscribe(...)` but exposed on the mount handle.
     */
    onSelectionChange?: (selectedIds: readonly string[]) => void;
    /**
     * Optional prompt override. Defaults to `window.prompt`. Lets tests
     * supply a deterministic text without monkey-patching globals.
     */
    promptText?: (defaultValue: string) => string | null;
}

/** Returned handle for the host page. */
export interface ImageEditModeHandle {
    /** Show the panel + activate `select` by default. */
    enable(): void;
    /** Hide the panel + reset tool to `select`. */
    disable(): void;
    /** Toggle and return the new state. */
    toggle(): boolean;
    /** Whether edit mode is currently enabled. */
    isEnabled(): boolean;
    /** Direct ToolManager access for #12-#15. */
    readonly toolManager: ToolManager;
    /** Direct ElementManager access for #13-#15. */
    readonly elementManager: ElementManager;
    /** Direct SelectionManager access for #14-#15 (issue #13). */
    readonly selectionManager: SelectionManager;
    /** Direct DragDropManager access for #14 (issue #13). */
    readonly dragDropManager: DragDropManager;
    /** Direct ResizeManager access (issue #14). */
    readonly resizeManager: ResizeManager;
    /** Direct PropertiesPanel handle (issue #14). */
    readonly propertiesPanel: PropertiesPanelHandle;
    /** The DOM node receiving canvas clicks for element creation. */
    readonly editCanvas: HTMLElement;
    /** The `#selectionInfo` span next to the tool buttons (issue #13). */
    readonly selectionInfo: HTMLElement;
    /** The `#deleteSelected` button next to the tool buttons (issue #13). */
    readonly deleteSelectedButton: HTMLButtonElement;
    /** Detach listeners + remove DOM. */
    dispose(): void;
}

/** Per-tool button label. Emoji follow the rest of the viewer's button style. */
const TOOL_BUTTON_LABEL: Record<ToolName, string> = {
    select: 'Select',
    text: 'Text',
    circle: 'Circle',
    rect: 'Rectangle',
    delete: 'Delete'
};

/** DOM ID used by the existing image viewer markup for the edit-mode panel. */
export const EDIT_CONTROLS_ID = 'editControls';

/** DOM id for the "N selected" status span (issue #13). */
export const SELECTION_INFO_ID = 'selectionInfo';

/** DOM id for the "delete selected" button (issue #13). */
export const DELETE_SELECTED_ID = 'deleteSelected';

/** Default text for new text elements when no prompt override is supplied. */
const DEFAULT_NEW_TEXT = 'Text';

/** Tools that, when active + canvas clicked, create a new element. */
const CREATABLE_TOOLS: ReadonlySet<ElementType> = new Set<ElementType>(['text', 'circle', 'rect']);

/**
 * Build the edit-mode shell (`.iv-edit-controls` + 5 buttons) and wire it
 * to a fresh `ToolManager`. Returns an imperative handle so callers can
 * enable/disable from elsewhere (e.g. the `#toggleEditMode` button click,
 * or a future menu).
 */
export function mountImageEditMode(options: MountImageEditModeOptions): ImageEditModeHandle {
    const {
        host,
        canvas: providedCanvas,
        canvasHost,
        onToggle,
        onToolActivate,
        onElementCreate,
        onSelectionChange,
        promptText
    } = options;

    // Build (or adopt) the edit canvas. When the caller doesn't supply one,
    // we create a `.iv-edit-canvas` div + mount it onto `canvasHost` (or the
    // panel host as a fallback). The canvas is the surface clicks register
    // on for element creation; #13 hit-tests use it as the local origin.
    const editCanvas = providedCanvas ?? createDiv('iv-edit-canvas');
    if (!providedCanvas) {
        // Created-by-us path: parent it to the requested host. We do NOT
        // size or position it here — the host page (imageViewerMain) owns
        // layout via CSS. We just guarantee it's pointer-event eligible.
        editCanvas.style.pointerEvents = 'auto';
        const canvasParent = canvasHost ?? host;
        canvasParent.appendChild(editCanvas);
    }
    setVisible(editCanvas, false);

    const toolManager = new ToolManager({ canvas: editCanvas, initialTool: 'select' });
    const elementManager = new ElementManager({ canvas: editCanvas });
    const selectionManager = new SelectionManager({ elementManager });
    const dragDropManager = new DragDropManager({
        canvas: editCanvas,
        elementManager,
        selectionManager,
        toolManager
    });
    const resizeManager = new ResizeManager({
        elementManager,
        selectionManager,
        toolManager
    });

    const panel = createDiv('iv-edit-controls');
    panel.id = EDIT_CONTROLS_ID;
    setVisible(panel, false); // Start hidden — #toggleEditMode flips it on.

    // Build one button per tool. Order matches `ALL_TOOLS` (select, text,
    // circle, rect, delete) — that order is also used by the test suite.
    for (const tool of ALL_TOOLS) {
        const btn = createButton(TOOL_BUTTON_LABEL[tool], 'iv-edit-btn', `iv-edit-btn--${tool}`);
        btn.dataset.tool = tool;
        toolManager.registerButton(tool, btn);
        panel.appendChild(btn);
    }

    // Selection info span + delete-selected button (issue #13). The span is
    // hidden until ≥1 element is selected; the button is always visible but
    // disabled when the selection is empty. The button uses a distinct base
    // class (`iv-edit-action-btn`) so panel queries for `.iv-edit-btn` (the
    // tool buttons) don't accidentally include it.
    const deleteSelectedButton = createButton('Delete selected', 'iv-edit-action-btn', 'iv-edit-action-btn--delete-selected');
    deleteSelectedButton.id = DELETE_SELECTED_ID;
    deleteSelectedButton.disabled = true;
    panel.appendChild(deleteSelectedButton);

    const selectionInfo = document.createElement('span');
    selectionInfo.id = SELECTION_INFO_ID;
    selectionInfo.className = 'iv-selection-info';
    setVisible(selectionInfo, false);
    panel.appendChild(selectionInfo);

    host.appendChild(panel);

    // Properties panel (issue #14) — appended next to the tool panel so it
    // sits inline with the rest of the edit-mode chrome. The panel hides
    // itself when the selection isn't exactly one element, so we don't need
    // to gate it from here.
    const propertiesPanel = mountPropertiesPanel({
        elementManager,
        selectionManager,
        host
    });

    // Reflect listener intent immediately. The activation listener fires
    // both for sticky tool switches AND the one-shot `'delete'` action,
    // matching the VSCode original's `onLogMessage('${tool} tool selected')`
    // semantics.
    const unsubscribeListener = onToolActivate
        ? toolManager.subscribe(onToolActivate)
        : () => {};

    // Selection -> info span + delete button enabled state. We always update
    // these regardless of `enabled`, so the host page can mirror selection
    // state without re-mounting.
    const renderSelectionUI = (count: number): void => {
        if (count > 0) {
            selectionInfo.textContent = `${count} selected`;
            setVisible(selectionInfo, true);
        } else {
            selectionInfo.textContent = '';
            setVisible(selectionInfo, false);
        }
        deleteSelectedButton.disabled = count === 0;
    };
    const unsubscribeSelection = selectionManager.subscribe((ids) => {
        renderSelectionUI(ids.length);
        onSelectionChange?.(ids);
    });
    renderSelectionUI(0);

    /**
     * Delete every currently-selected element. Wired both to the
     * `#deleteSelected` button and the Delete / Backspace key. ElementManager
     * has no per-id remove yet (it lands in #14), but the only path used
     * today by tests + tools is "remove every selected element", which we
     * implement by clearing all elements when the selection covers the
     * whole list, otherwise by re-creating the surviving elements.
     *
     * NOTE: To keep ElementManager unchanged for #13, we do a minimal local
     * "remove by id" that:
     *   - drops the matching DOM nodes,
     *   - removes the matching ElementData entries,
     *   - notifies ElementManager listeners via its public surface (we
     *     piggy-back on `clear()` when the selection covers everything; for
     *     partial deletes we mutate the public list snapshot via internal
     *     access patterns reachable through the existing API, falling back
     *     to a clear+rebuild if no public path exists).
     *
     * In practice, the ElementManager API exposes `getNode(id)` so we can
     * remove the node ourselves; for the data-side removal we use the only
     * mutation the public API gives us — `clear()` — and then rebuild any
     * survivors. Inefficient but correct, and only runs on user-initiated
     * deletes. #14 will replace this with a real per-id remove.
     */
    const deleteSelected = (): void => {
        const ids = selectionManager.list();
        if (ids.length === 0) return;
        const idSet = new Set(ids);
        const survivors = elementManager.list().filter((el) => !idSet.has(el.id));

        if (survivors.length === 0) {
            // Common case: delete-all. Cheapest path.
            elementManager.clear();
            return;
        }

        // Drop the to-be-deleted nodes from the DOM up front so users see
        // them disappear immediately.
        for (const id of ids) {
            const node = elementManager.getNode(id);
            if (node && node.parentElement) {
                node.parentElement.removeChild(node);
            }
        }
        // Snapshot survivors before clear() drops the data.
        const snapshots = survivors.map((el) => ({ ...el, style: { ...el.style } }));
        elementManager.clear();
        for (const data of snapshots) {
            if (data.type === 'text') {
                elementManager.addText({
                    x: data.x,
                    y: data.y,
                    text: data.text,
                    fontSize: data.style.fontSize,
                    color: data.style.fill,
                    opacity: data.style.opacity
                });
            } else if (data.type === 'circle') {
                elementManager.addCircle({
                    x: data.x,
                    y: data.y,
                    w: data.w,
                    h: data.h,
                    fill: data.style.fill,
                    stroke: data.style.stroke,
                    strokeWidth: data.style.strokeWidth,
                    opacity: data.style.opacity
                });
            } else if (data.type === 'rect') {
                elementManager.addRectangle({
                    x: data.x,
                    y: data.y,
                    w: data.w,
                    h: data.h,
                    fill: data.style.fill,
                    stroke: data.style.stroke,
                    strokeWidth: data.style.strokeWidth,
                    opacity: data.style.opacity
                });
            }
        }
    };

    deleteSelectedButton.addEventListener('click', () => {
        if (!enabled) return;
        deleteSelected();
    });

    // Canvas-click -> element creation. Only fires when the active tool is
    // text / circle / rect. Coordinates are computed relative to the canvas
    // so the element ends up where the user clicked, regardless of where
    // the canvas sits on the page (the image viewer can scroll / zoom).
    const onCanvasClick = (e: MouseEvent): void => {
        if (!enabled) return;
        const tool = toolManager.getActive();
        if (!CREATABLE_TOOLS.has(tool as ElementType)) return;
        // Only handle clicks landing on the canvas itself or its empty
        // areas — clicks on already-rendered elements are #13's territory.
        if (e.target !== editCanvas) return;

        const rect = editCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        let created: ElementData | null = null;
        if (tool === 'text') {
            const askPrompt = promptText
                ?? ((def: string) => (typeof window !== 'undefined' && typeof window.prompt === 'function'
                    ? window.prompt('Text:', def)
                    : def));
            const value = askPrompt(DEFAULT_NEW_TEXT);
            if (value === null || value === '') {
                return;
            }
            created = elementManager.addText({ x, y, text: value });
        } else if (tool === 'circle') {
            created = elementManager.addCircle({ x, y });
        } else if (tool === 'rect') {
            created = elementManager.addRectangle({ x, y });
        }
        if (created && onElementCreate) {
            onElementCreate(created);
        }
    };
    editCanvas.addEventListener('click', onCanvasClick);

    let enabled = false;

    // ESC handler — only active while edit mode is enabled. We attach to
    // `document` (not the panel) so it works even when the canvas overlay
    // (added in #12) steals pointer focus.
    const onKeyDown = (e: KeyboardEvent): void => {
        if (!enabled) return;
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
        }
        if (e.key === 'Escape') {
            toolManager.resetToSelect();
            // We deliberately do NOT preventDefault here — ESC should still
            // close other UI affordances (modals, etc.) on the host page.
            return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            // Only act when there's an actual selection — let Backspace
            // navigate the host page when no selection is held.
            if (selectionManager.count() === 0) return;
            e.preventDefault();
            deleteSelected();
            return;
        }
    };

    const enable = (): void => {
        if (enabled) return;
        enabled = true;
        setVisible(panel, true);
        setVisible(editCanvas, true);
        toolManager.activate('select');
        document.addEventListener('keydown', onKeyDown);
        onToggle?.(true);
    };

    const disable = (): void => {
        if (!enabled) return;
        enabled = false;
        setVisible(panel, false);
        setVisible(editCanvas, false);
        // Drop selection so resize handles + properties panel hide too —
        // re-entering edit mode shouldn't pick up a stale single-select.
        selectionManager.clear();
        toolManager.resetToSelect();
        document.removeEventListener('keydown', onKeyDown);
        onToggle?.(false);
    };

    const toggle = (): boolean => {
        if (enabled) {
            disable();
        } else {
            enable();
        }
        return enabled;
    };

    const dispose = (): void => {
        document.removeEventListener('keydown', onKeyDown);
        editCanvas.removeEventListener('click', onCanvasClick);
        unsubscribeListener();
        unsubscribeSelection();
        // Tear down #14 surfaces BEFORE the underlying selection /
        // element managers — they subscribe to those.
        propertiesPanel.dispose();
        resizeManager.dispose();
        dragDropManager.dispose();
        selectionManager.dispose();
        elementManager.dispose();
        toolManager.dispose();
        if (panel.parentElement) {
            panel.parentElement.removeChild(panel);
        }
        // Only remove the edit canvas if we created it. If the caller passed
        // their own, they own its lifecycle.
        if (!providedCanvas && editCanvas.parentElement) {
            editCanvas.parentElement.removeChild(editCanvas);
        }
    };

    return {
        enable,
        disable,
        toggle,
        isEnabled: () => enabled,
        toolManager,
        elementManager,
        selectionManager,
        dragDropManager,
        resizeManager,
        propertiesPanel,
        editCanvas,
        selectionInfo,
        deleteSelectedButton,
        dispose
    };
}
