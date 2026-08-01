// KaTeX layout CSS + web fonts for the core viewers that render math.
//
// omni-viewer-core renders math into an isolated shadow root and deliberately
// ships no math CSS (omni-viewer-core/docs/viewers/latex.md §5) — loading
// `katex.css` is the adapter's job. That needs *two* insertions, not one:
//
//   - the shadow root, because the `.katex*` layout selectors only match
//     inside the tree that actually holds the rendered math. A stylesheet in
//     <head> never crosses the shadow boundary.
//   - <head>, because `@font-face` is document-scoped: font faces declared
//     inside a shadow tree are ignored. Without this the formulas still
//     render, but they fall back to a system font and the spacing and symbol
//     alignment KaTeX depends on break.
//
// `katex.min.css` references its fonts as `fonts/KaTeX_*.woff2` — a relative
// URL — so webpack copies the whole `fonts` directory next to the stylesheet
// under `assets/katex/` (see webpack.config.js) and both are declared in
// `web_accessible_resources`.

/** Path of the copied stylesheet, relative to the extension root. */
export const KATEX_STYLESHEET_PATH = 'assets/katex/katex.min.css';

/** Marks our <link> so repeated mounts don't stack duplicates. */
const KATEX_LINK_MARKER = 'data-omni-katex';

/**
 * Extension URL of the stylesheet. Falls back to the plain relative path when
 * `chrome.runtime` is unavailable (standalone template harness, tests).
 */
export function katexStylesheetUrl(): string {
    return typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL(KATEX_STYLESHEET_PATH)
        : KATEX_STYLESHEET_PATH;
}

/**
 * Add the stylesheet to one root. Idempotent via the marker attribute, so it
 * is safe to call on every mount.
 */
export function injectKatexStylesheet(root: (ParentNode & Node) | null | undefined): void {
    if (!root || typeof document === 'undefined') return;
    // `document` itself rejects a second element child; callers pass
    // `document.head` rather than `document` for exactly that reason.
    if ((root as Element | ShadowRoot).querySelector?.(`link[${KATEX_LINK_MARKER}]`)) return;

    const link = document.createElement('link');
    link.setAttribute(KATEX_LINK_MARKER, '');
    link.rel = 'stylesheet';
    link.href = katexStylesheetUrl();
    root.appendChild(link);
}

/**
 * Install KaTeX styling for a viewer mounted into `container`.
 *
 * Always styles the document (fonts), and additionally the shadow root when
 * the core mounted into one. With `styleIsolation: 'scoped'` there is no
 * shadow root and the document-level stylesheet already covers the viewer.
 */
export function installKatexStyles(container: HTMLElement): void {
    if (typeof document === 'undefined') return;
    injectKatexStylesheet(document.head);
    injectKatexStylesheet(container.shadowRoot);
}
