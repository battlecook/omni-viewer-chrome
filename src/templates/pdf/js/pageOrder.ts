// Pure reducer for the PDF page-order state (issue #22).
//
// State model
// -----------
// `PageOrderState.order` is an array of 1-based page numbers describing
// the *current* visible order. The *original* PDF is never mutated by
// this module; saving a modified document is issue #23. Therefore:
//
//   - reorder(state, fromIdx, toIdx) — move the entry at `fromIdx` to
//     `toIdx` (both 0-based positions in `order`).
//   - deletePage(state, idx)        — remove the entry at `idx` (0-based
//     position in `order`). Refuses to delete the last remaining page;
//     callers can detect this by `state === next` (referential identity)
//     or by checking `state.order.length === 1` first.
//   - resetOrder(numPages)          — return the identity state
//     `[1, 2, …, numPages]`. Used both at mount and as the "Reset" UI
//     action.
//   - isModified(state)             — true iff `order` is not identity.
//
// Identity
// --------
// All operations return a *new* state object on success so consumers can
// rely on `prevState !== nextState` as a "did the order change?" signal.
// On no-op (e.g. delete-last-page, fromIdx === toIdx, out-of-range
// indices), the original `state` reference is returned unchanged.
//
// Out-of-range / invalid inputs are treated as no-ops rather than
// thrown; the caller (DOM event handler) gets noisy DnD events from the
// browser and we don't want to crash the viewer on a stray drop.

export interface PageOrderState {
    /** 1-based original page numbers in their current visible order. */
    readonly order: readonly number[];
    /** Frozen snapshot of the identity order (page count never changes). */
    readonly numPages: number;
}

/**
 * Build the identity state for a `numPages`-page PDF.
 * `numPages` is clamped to a non-negative integer.
 */
export function resetOrder(numPages: number): PageOrderState {
    const safe = Math.max(0, Math.floor(numPages));
    const order: number[] = [];
    for (let i = 1; i <= safe; i++) order.push(i);
    return { order, numPages: safe };
}

/**
 * True iff the current order differs from identity (`[1, 2, …, n]`) or
 * a page has been deleted (length shrunk).
 */
export function isModified(state: PageOrderState): boolean {
    if (state.order.length !== state.numPages) return true;
    for (let i = 0; i < state.order.length; i++) {
        if (state.order[i] !== i + 1) return true;
    }
    return false;
}

/**
 * Move the entry at `fromIdx` to `toIdx`. Both are 0-based positions in
 * `state.order`. No-ops (returns the same reference) when:
 *   - either index is out of `[0, length - 1]`
 *   - `fromIdx === toIdx`
 */
export function reorder(
    state: PageOrderState,
    fromIdx: number,
    toIdx: number
): PageOrderState {
    const len = state.order.length;
    if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) return state;
    if (fromIdx < 0 || fromIdx >= len) return state;
    if (toIdx < 0 || toIdx >= len) return state;
    if (fromIdx === toIdx) return state;
    const next = state.order.slice();
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    return { order: next, numPages: state.numPages };
}

/**
 * Delete the entry at `idx` (0-based) from the visible order. Refuses
 * to delete the last remaining page (returns `state` unchanged).
 */
export function deletePage(
    state: PageOrderState,
    idx: number
): PageOrderState {
    const len = state.order.length;
    if (!Number.isInteger(idx)) return state;
    if (idx < 0 || idx >= len) return state;
    if (len <= 1) return state; // refuse to delete the last remaining page
    const next = state.order.slice();
    next.splice(idx, 1);
    return { order: next, numPages: state.numPages };
}

/**
 * Convenience: which 1-based original page numbers are currently
 * deleted (i.e. present in identity but absent from `state.order`)?
 * Useful for hiding the corresponding `.pv-page-wrapper` elements.
 */
export function deletedPageNumbers(state: PageOrderState): number[] {
    const present = new Set(state.order);
    const out: number[] = [];
    for (let i = 1; i <= state.numPages; i++) {
        if (!present.has(i)) out.push(i);
    }
    return out;
}
