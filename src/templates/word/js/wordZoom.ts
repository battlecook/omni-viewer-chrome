// Zoom-level state machine for the Chrome Word viewer (issue #43).
//
// The legacy SPA's word renderer (`src/app.js#renderWord`) uses
// docx-preview but exposes neither zoom nor print. The VSCode reference
// (`vscode-omni-viewer/src/templates/word/js/wordViewer.js`) ships a
// continuous +/- step ladder (MIN 25%, MAX 200%, STEP 10%) that does not
// quite match issue #43's "50%~250% in 10 steps" requirement.
//
// Issue #43 fixes the ladder to a discrete 10-step sequence between 50%
// and 250%. We pick the canonical even-step ladder:
//
//   50 / 75 / 100 / 125 / 150 / 175 / 200 / 225 / 250
//
// That is only 9 levels, so we add a 60% step at the bottom to land on
// the required count of 10 while keeping 100% / 150% / 200% (the "round
// number" anchors most users will hit) on the ladder.
//
// All math is intentionally side-effect free so the helpers can be
// unit-tested without a DOM (`src/__tests__/wordZoom.test.ts`).

/**
 * Discrete zoom levels for the Word viewer, expressed as percentages.
 * The sequence is monotonically increasing — `nextZoom` / `prevZoom`
 * both rely on that ordering. Length is exactly 10 to satisfy the
 * issue's "10 steps" requirement.
 */
export const WORD_ZOOM_LEVELS_PERCENT: readonly number[] = [
    50, 60, 75, 100, 125, 150, 175, 200, 225, 250
] as const;

/**
 * Default zoom percent. 100% is on the ladder so stepping up / down
 * lands cleanly on adjacent levels with no off-ladder snap.
 */
export const WORD_DEFAULT_ZOOM_PERCENT = 100;

/**
 * Min / max convenience exports — reach for these instead of indexing
 * into `WORD_ZOOM_LEVELS_PERCENT` directly so callers stay decoupled
 * from the array layout.
 */
export const WORD_MIN_ZOOM_PERCENT =
    WORD_ZOOM_LEVELS_PERCENT[0];
export const WORD_MAX_ZOOM_PERCENT =
    WORD_ZOOM_LEVELS_PERCENT[WORD_ZOOM_LEVELS_PERCENT.length - 1];

/**
 * Clamp an arbitrary input percentage into the [min, max] range of the
 * ladder. Does NOT snap to a ladder level — use `nearestZoomIndex` for
 * that.
 */
export function clampZoom(percent: number): number {
    if (!Number.isFinite(percent)) {
        return WORD_DEFAULT_ZOOM_PERCENT;
    }
    if (percent < WORD_MIN_ZOOM_PERCENT) return WORD_MIN_ZOOM_PERCENT;
    if (percent > WORD_MAX_ZOOM_PERCENT) return WORD_MAX_ZOOM_PERCENT;
    return percent;
}

/**
 * Find the index of `percent` inside `WORD_ZOOM_LEVELS_PERCENT`. If it
 * is not an exact match, returns the index of the nearest level. Used
 * internally to recover from "set zoom to an arbitrary value, now where
 * am I in the ladder?" — keeps step navigation deterministic.
 *
 * Tie-breaks favor the lower index (matches PDF viewer convention).
 */
export function nearestZoomIndex(percent: number): number {
    let bestIdx = 0;
    let bestDelta = Math.abs(WORD_ZOOM_LEVELS_PERCENT[0] - percent);
    for (let i = 1; i < WORD_ZOOM_LEVELS_PERCENT.length; i++) {
        const delta = Math.abs(WORD_ZOOM_LEVELS_PERCENT[i] - percent);
        if (delta < bestDelta) {
            bestDelta = delta;
            bestIdx = i;
        }
    }
    return bestIdx;
}

/**
 * Step up: returns the next-higher zoom level, or the current value if
 * already at the top of the ladder. Exported for direct unit-testing.
 */
export function nextZoom(currentPercent: number): number {
    const idx = nearestZoomIndex(currentPercent);
    const nextIdx = Math.min(idx + 1, WORD_ZOOM_LEVELS_PERCENT.length - 1);
    return WORD_ZOOM_LEVELS_PERCENT[nextIdx];
}

/**
 * Step down: returns the next-lower zoom level, or the current value
 * if already at the bottom of the ladder.
 */
export function prevZoom(currentPercent: number): number {
    const idx = nearestZoomIndex(currentPercent);
    const prevIdx = Math.max(idx - 1, 0);
    return WORD_ZOOM_LEVELS_PERCENT[prevIdx];
}

/**
 * Format a zoom percent into the toolbar label. Centralized so the
 * renderer and the entry agree on the rendering (e.g. trailing `%`).
 */
export function formatZoomLabel(percent: number): string {
    return `${Math.round(percent)}%`;
}

/**
 * Returns true when stepping down would change the value — used to
 * decide whether to disable the `−` button.
 */
export function canZoomOut(percent: number): boolean {
    return nearestZoomIndex(percent) > 0;
}

/**
 * Returns true when stepping up would change the value — used to decide
 * whether to disable the `+` button.
 */
export function canZoomIn(percent: number): boolean {
    return nearestZoomIndex(percent) < WORD_ZOOM_LEVELS_PERCENT.length - 1;
}

/**
 * Convert a zoom-percent (50, 100, 250…) to the multiplier consumed by
 * `transform: scale(...)` (0.5, 1.0, 2.5…).
 */
export function percentToScale(percent: number): number {
    return percent / 100;
}
