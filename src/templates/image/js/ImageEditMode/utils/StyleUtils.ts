// StyleUtils — minimum stubs for issue #11.
//
// Port note: the VSCode `StyleUtils.js` ships text/circle/rectangle style
// updaters that depend on element data shapes (#12) and color/opacity
// math (ColorUtils). Issue #11 only owns the edit-mode shell + tool
// switching, so we expose just the cursor-class helper here. #12-#14 will
// extend this file with the element style updaters as those data types
// are introduced.

import type { ToolName } from '../managers/ToolManager';
import { TOOL_CURSOR_CLASS } from '../managers/ToolManager';

/**
 * Apply the cursor class for `tool` to `canvas`, removing any previous
 * `iv-cursor-*` class. Mirrors the logic inside `ToolManager.syncCanvasClasses`
 * for callers that want to drive cursor state without going through the
 * manager (e.g. tests, future per-element drag overlays in #13).
 *
 * `'delete'` clears the cursor class — there is no sticky cursor for it.
 */
export function applyToolCursor(canvas: HTMLElement, tool: ToolName): void {
    for (const cls of Object.values(TOOL_CURSOR_CLASS)) {
        canvas.classList.remove(cls);
    }
    if (tool !== 'delete') {
        canvas.classList.add(TOOL_CURSOR_CLASS[tool]);
    }
}

/**
 * Toggle a class on an element. Tiny wrapper that keeps call sites
 * uniform with future StyleUtils helpers (`applySelectedStyles`, etc.,
 * landing in #13).
 */
export function toggleClass(element: HTMLElement, className: string, on: boolean): void {
    element.classList.toggle(className, on);
}
