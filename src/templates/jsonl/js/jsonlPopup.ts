// Popup positioning + debounce helpers for the JSONL hover viewer (issue #59).
//
// The popup is purely a visual layer over the row list; the orchestrator
// (`jsonlViewerMain.ts`) is responsible for parsing JSON lines, attaching
// hover handlers, and feeding parsed payloads into `attachPopup().show()`.
//
// This module is intentionally DOM-light so its core logic — viewport
// clamping math + debounce timing — can be unit-tested without jsdom.
//
// The split mirrors the JSON viewer's `jsonTree.ts` / `jsonViewerMain.ts`
// split: pure helpers here, glue code in the main module.

import { tokenizeJson } from '../../json/js/jsonTokenizer';

/**
 * Inputs to {@link clampPopupPosition}. All measurements are in CSS px.
 *
 * `mouseX` / `mouseY` are the cursor coordinates (typically `MouseEvent`'s
 * `clientX` / `clientY`). `popupW` / `popupH` are the popup's intended
 * dimensions. `viewportW` / `viewportH` are `window.innerWidth` /
 * `window.innerHeight`.
 *
 * `margin` is an optional inset (default 12px) so the popup never hugs the
 * viewport edge.
 *
 * `offsetX` / `offsetY` are how far past the cursor the popup should sit
 * before clamping; they default to 16 / 12 respectively, which keeps the
 * popup from covering the row the user is hovering over.
 */
export interface ClampPopupPositionInput {
    mouseX: number;
    mouseY: number;
    popupW: number;
    popupH: number;
    viewportW: number;
    viewportH: number;
    margin?: number;
    offsetX?: number;
    offsetY?: number;
}

export interface ClampedPosition {
    left: number;
    top: number;
}

/**
 * Compute a `{left, top}` position for a popup of size `popupW × popupH`
 * relative to a cursor at `(mouseX, mouseY)`, clamped to stay within
 * `viewportW × viewportH` (minus `margin` on every side).
 *
 * Behaviour:
 *
 *   - Default placement is to the right of the cursor (`mouseX + offsetX`).
 *     If that would push the popup past the right edge, it flips to the
 *     left side (`mouseX - offsetX - popupW`). If that *also* doesn't fit
 *     (cursor near the left edge of a narrow viewport) we fall back to
 *     clamping at the left margin.
 *
 *   - Default vertical placement is just below the cursor
 *     (`mouseY + offsetY`). If that overflows the bottom we shift the
 *     popup up so it ends at `viewportH - margin`. If even that lands the
 *     popup above the top margin (very small viewport) we clamp it to
 *     the top margin.
 *
 * The returned coordinates are guaranteed to keep the popup's full box
 * inside `[margin, viewport - margin]` whenever the popup itself fits in
 * that region. If the popup is larger than the available area, it is
 * pinned to `margin` so the top-left stays visible.
 */
export function clampPopupPosition(input: ClampPopupPositionInput): ClampedPosition {
    const margin = input.margin ?? 12;
    const offsetX = input.offsetX ?? 16;
    const offsetY = input.offsetY ?? 12;

    const minLeft = margin;
    const maxLeft = Math.max(margin, input.viewportW - input.popupW - margin);
    const minTop = margin;
    const maxTop = Math.max(margin, input.viewportH - input.popupH - margin);

    // Horizontal: prefer placing to the right of the cursor.
    let left = input.mouseX + offsetX;
    if (left + input.popupW > input.viewportW - margin) {
        // Try flipping to the left side of the cursor.
        const flipped = input.mouseX - offsetX - input.popupW;
        if (flipped >= minLeft) {
            left = flipped;
        } else {
            left = maxLeft;
        }
    }
    if (left < minLeft) left = minLeft;
    if (left > maxLeft) left = maxLeft;

    // Vertical: prefer placing just below the cursor.
    let top = input.mouseY + offsetY;
    if (top + input.popupH > input.viewportH - margin) {
        top = input.viewportH - input.popupH - margin;
    }
    if (top < minTop) top = minTop;
    if (top > maxTop) top = maxTop;

    return { left, top };
}

// ---------------------------------------------------------------------------
// Popup factory.
// ---------------------------------------------------------------------------

export interface PopupHandle {
    /**
     * Show the popup near `(mouseX, mouseY)` with `text` as its body.
     * No-op if the host has been disposed.
     */
    show(text: string, mouseX: number, mouseY: number): void;

    /**
     * Hide the popup immediately and cancel any pending debounced show.
     */
    hide(): void;

    /**
     * Schedule a `show()` after `delayMs` (default 150). Calling
     * `scheduleShow` again before the timer fires resets it. Calling
     * {@link hide} or {@link cancelPending} cancels the pending show.
     */
    scheduleShow(text: string, mouseX: number, mouseY: number, delayMs?: number): void;

    /**
     * Cancel a pending {@link scheduleShow} without affecting visibility.
     */
    cancelPending(): void;

    /**
     * Tear down all DOM + listeners owned by the popup.
     */
    dispose(): void;

    /**
     * Test-only handle to the underlying element, so unit tests can assert
     * positioning without exercising the entire viewer.
     */
    readonly element: HTMLDivElement;
}

export interface AttachPopupOptions {
    /**
     * Default debounce in ms used by {@link PopupHandle.scheduleShow}
     * when the caller does not supply an explicit `delayMs`.
     * VSCode reference uses 200ms; we default to 150 because the issue
     * spec calls for "~150ms".
     */
    defaultDelayMs?: number;

    /**
     * Popup width in CSS px. Default 480.
     */
    width?: number;

    /**
     * Popup height in CSS px. Default 360.
     */
    height?: number;

    /**
     * Class name applied to the root popup element so callers can style
     * it. Default `omni-jsonl-popup`.
     */
    className?: string;

    /**
     * Override `setTimeout` / `clearTimeout`. Tests use this to drive the
     * debounce without `jest.useFakeTimers()`.
     */
    timers?: {
        setTimeout: (cb: () => void, ms: number) => number;
        clearTimeout: (handle: number) => void;
    };

    /**
     * Override viewport dimensions. Defaults to live `window.innerWidth`
     * / `window.innerHeight`. Tests can pin these to a deterministic
     * value so positioning math is reproducible.
     */
    getViewport?: () => { width: number; height: number };
}

/**
 * Create a singleton popup attached to `host`. The element is a positioned
 * `div` containing a `<pre>` that displays JSON text. The popup is hidden
 * by default; callers drive it through the returned handle.
 *
 * The factory is idempotent in the sense that disposing the handle removes
 * the element + listeners, leaving `host` untouched.
 */
export function attachPopup(host: HTMLElement, options: AttachPopupOptions = {}): PopupHandle {
    const defaultDelay = options.defaultDelayMs ?? 150;
    const width = options.width ?? 480;
    const height = options.height ?? 360;
    const className = options.className ?? 'omni-jsonl-popup';
    const setT = options.timers?.setTimeout ?? ((cb, ms) => window.setTimeout(cb, ms));
    const clrT = options.timers?.clearTimeout ?? ((h) => window.clearTimeout(h));
    const getViewport =
        options.getViewport ??
        (() => ({ width: window.innerWidth, height: window.innerHeight }));

    const el = document.createElement('div');
    el.className = className;
    el.setAttribute('role', 'tooltip');
    el.setAttribute('aria-hidden', 'true');
    el.style.position = 'fixed';
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.display = 'none';
    el.style.pointerEvents = 'none';

    const pre = document.createElement('pre');
    pre.className = `${className}-content`;
    el.appendChild(pre);

    host.appendChild(el);

    let pendingTimer: number | null = null;
    let disposed = false;

    function clearPending(): void {
        if (pendingTimer !== null) {
            clrT(pendingTimer);
            pendingTimer = null;
        }
    }

    function show(text: string, mouseX: number, mouseY: number): void {
        if (disposed) return;
        clearPending();
        renderHighlightedJson(pre, text);
        const vp = getViewport();
        const { left, top } = clampPopupPosition({
            mouseX,
            mouseY,
            popupW: width,
            popupH: height,
            viewportW: vp.width,
            viewportH: vp.height
        });
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.display = 'block';
        el.setAttribute('aria-hidden', 'false');
    }

    function hide(): void {
        if (disposed) return;
        clearPending();
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
    }

    function scheduleShow(
        text: string,
        mouseX: number,
        mouseY: number,
        delayMs?: number
    ): void {
        if (disposed) return;
        clearPending();
        const ms = delayMs ?? defaultDelay;
        pendingTimer = setT(() => {
            pendingTimer = null;
            show(text, mouseX, mouseY);
        }, ms);
    }

    function dispose(): void {
        if (disposed) return;
        disposed = true;
        clearPending();
        if (el.parentNode) {
            el.parentNode.removeChild(el);
        }
    }

    return {
        show,
        hide,
        scheduleShow,
        cancelPending: clearPending,
        dispose,
        element: el
    };
}

/**
 * Render pretty JSON into the popup using the same token palette as JSONL
 * rows. Text nodes are used for whitespace so indentation and line breaks
 * remain byte-for-byte identical to `JSON.stringify(value, null, 2)`.
 */
export function renderHighlightedJson(pre: HTMLElement, text: string): void {
    pre.textContent = '';
    for (const token of tokenizeJson(text)) {
        if (token.kind === 'whitespace') {
            pre.appendChild(document.createTextNode(token.text));
            continue;
        }
        const span = document.createElement('span');
        span.className = `jl-tok-${token.kind}`;
        span.textContent = token.text;
        pre.appendChild(span);
    }
}

// ---------------------------------------------------------------------------
// Pure parse helpers.
// ---------------------------------------------------------------------------

/**
 * Result of attempting to parse a single JSONL line. We keep this as a
 * tagged union rather than a `T | null` so the orchestrator can treat
 * "empty line" identically to "valid JSON `null`" without ambiguity.
 */
export type ParsedLine =
    | { kind: 'valid'; value: unknown; formatted: string }
    | { kind: 'invalid'; raw: string; error: string }
    | { kind: 'empty' };

/**
 * Parse a single JSONL line. Whitespace-only lines return `{kind: 'empty'}`.
 * On parse failure we keep the raw text + error string so the row can be
 * rendered with an "invalid JSON" indicator (issue #59 step 4).
 *
 * `formatted` is the pretty-printed (`JSON.stringify(value, null, 2)`)
 * payload that the popup displays. We compute it eagerly here so the
 * cache stored by the orchestrator can be a flat array of `ParsedLine`
 * with no further work on hover.
 */
export function parseJsonlLine(raw: string): ParsedLine {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return { kind: 'empty' };
    }
    try {
        const value = JSON.parse(trimmed) as unknown;
        return {
            kind: 'valid',
            value,
            formatted: JSON.stringify(value, null, 2)
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { kind: 'invalid', raw, error };
    }
}

/**
 * Split raw file text into JSONL lines. Handles both LF and CRLF endings.
 * A trailing newline is treated as a "no trailing empty line" — we don't
 * emit a synthetic empty entry for it. Empty interior lines ARE preserved
 * so line numbers stay 1:1 with the source file.
 */
export function splitJsonlLines(text: string): string[] {
    if (text.length === 0) return [];
    // Normalise CRLF → LF first so `split('\n')` is enough.
    const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalised.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}
