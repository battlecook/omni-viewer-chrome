// DOMUtils — minimum stubs for issue #11.
//
// The VSCode `DOMUtils.js` carries a broader surface (createTextElement /
// createShapeElement / hit-testing / append-remove / z-index) that #12-#14
// will consume. Issue #11 only needs the helpers used by the edit-mode
// shell + ToolManager today. Everything else is intentionally left out so
// later issues can add per-feature exports without churning a giant file.
//
// Future expansion targets (DO NOT ADD HERE — for #12+):
//   - createTextElement / createShapeElement (#12)
//   - isPointInElement / findElementAt (#13)
//   - setPosition / setSize / setZIndex (#13/#14)
//
// Keep this file dependency-free.

/**
 * Create a `div` with the given class names. Used by ImageEditMode to
 * build the edit-mode shell + tool buttons without scattering raw
 * `document.createElement` calls. Empty strings are silently dropped so
 * `createDiv()` works.
 */
export function createDiv(...classNames: string[]): HTMLDivElement {
    const el = document.createElement('div');
    for (const cls of classNames) {
        if (cls) el.classList.add(cls);
    }
    return el;
}

/**
 * Create a `<button type="button">`. Defaults type=button so a button
 * embedded in any future `<form>` doesn't accidentally submit it. The
 * VSCode original relied on global stylesheet defaults; the Chrome port
 * runs inside the legacy SPA which DOES contain forms.
 */
export function createButton(label: string, ...classNames: string[]): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    for (const cls of classNames) {
        if (cls) btn.classList.add(cls);
    }
    return btn;
}

/**
 * Toggle the `hidden` style on an element. Centralized here so the
 * cursor-class story (StyleUtils) stays DOM-shape-agnostic. We use
 * `style.display` rather than the `hidden` HTML attribute because the
 * legacy SPA sometimes overrides `[hidden]` with `display: block !important`.
 */
export function setVisible(element: HTMLElement, visible: boolean): void {
    element.style.display = visible ? '' : 'none';
}

/** Safely append a child only if not already attached. */
export function appendIfDetached(parent: HTMLElement, child: HTMLElement): void {
    if (child.parentElement !== parent) {
        parent.appendChild(child);
    }
}
