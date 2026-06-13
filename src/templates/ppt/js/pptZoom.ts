// Zoom-level state machine for the Chrome PPT viewer (issue #49).
//
// Issue #49 pins the ladder to a discrete 6-step sequence. We pick the
// canonical "round number" anchors so 100% / 150% / 200% (the levels
// most users will reach for) stay on the ladder:
//
//   50 / 75 / 100 / 125 / 150 / 200
//
// The sibling Word viewer (`wordZoom.ts`) and PDF viewer (`pdfZoom.ts`)
// use the same pure-helper layout — `nextZoom` / `prevZoom` walk the
// ladder one rung at a time and clamp at the ends, `clampZoom` keeps an
// arbitrary input inside the [min, max] range without snapping to a
// rung. The `applyZoom` consumer in `pptViewerMain.ts` only ever passes
// in ladder values, but `clampZoom` keeps the math defensive in case a
// future feature (e.g. fit-to-width) sets an off-ladder percent.
//
// All math is intentionally side-effect free so the helpers can be
// unit-tested without a DOM (`src/__tests__/pptZoom.test.ts`).

/**
 * Discrete zoom levels for the PPT viewer, expressed as percentages.
 * The sequence is monotonically increasing — `nextZoom` / `prevZoom`
 * both rely on that ordering. Length is exactly 6 to satisfy the issue
 * #49 "6 steps" requirement.
 */
export const PPT_ZOOM_LEVELS_PERCENT: readonly number[] = [
    50, 75, 100, 125, 150, 200
] as const;

/**
 * Default zoom percent. 100% is on the ladder so stepping up / down
 * lands cleanly on adjacent levels with no off-ladder snap.
 */
export const PPT_DEFAULT_ZOOM_PERCENT = 100;

/**
 * Min / max convenience exports — reach for these instead of indexing
 * into `PPT_ZOOM_LEVELS_PERCENT` directly so callers stay decoupled
 * from the array layout.
 */
export const PPT_MIN_ZOOM_PERCENT =
    PPT_ZOOM_LEVELS_PERCENT[0];
export const PPT_MAX_ZOOM_PERCENT =
    PPT_ZOOM_LEVELS_PERCENT[PPT_ZOOM_LEVELS_PERCENT.length - 1];

/**
 * Clamp an arbitrary input percentage into the [min, max] range of the
 * ladder. Does NOT snap to a ladder level — use `nearestZoomIndex` for
 * that. Falls back to the default for non-finite input so a stray
 * `NaN` from a parse doesn't blow up the renderer.
 */
export function clampZoom(percent: number): number {
    if (!Number.isFinite(percent)) {
        return PPT_DEFAULT_ZOOM_PERCENT;
    }
    if (percent < PPT_MIN_ZOOM_PERCENT) return PPT_MIN_ZOOM_PERCENT;
    if (percent > PPT_MAX_ZOOM_PERCENT) return PPT_MAX_ZOOM_PERCENT;
    return percent;
}

/**
 * Find the index of `percent` inside `PPT_ZOOM_LEVELS_PERCENT`. If it
 * is not an exact match, returns the index of the nearest level. Used
 * internally to recover from "set zoom to an arbitrary value, now
 * where am I in the ladder?" — keeps step navigation deterministic.
 *
 * Tie-breaks favor the lower index (matches PDF / Word viewer
 * convention).
 */
export function nearestZoomIndex(percent: number): number {
    let bestIdx = 0;
    let bestDelta = Math.abs(PPT_ZOOM_LEVELS_PERCENT[0] - percent);
    for (let i = 1; i < PPT_ZOOM_LEVELS_PERCENT.length; i++) {
        const delta = Math.abs(PPT_ZOOM_LEVELS_PERCENT[i] - percent);
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
    const nextIdx = Math.min(idx + 1, PPT_ZOOM_LEVELS_PERCENT.length - 1);
    return PPT_ZOOM_LEVELS_PERCENT[nextIdx];
}

/**
 * Step down: returns the next-lower zoom level, or the current value
 * if already at the bottom of the ladder.
 */
export function prevZoom(currentPercent: number): number {
    const idx = nearestZoomIndex(currentPercent);
    const prevIdx = Math.max(idx - 1, 0);
    return PPT_ZOOM_LEVELS_PERCENT[prevIdx];
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
 * Returns true when stepping up would change the value — used to
 * decide whether to disable the `+` button.
 */
export function canZoomIn(percent: number): boolean {
    return nearestZoomIndex(percent) < PPT_ZOOM_LEVELS_PERCENT.length - 1;
}

/**
 * Convert a zoom-percent (50, 100, 200…) to the multiplier consumed by
 * `transform: scale(...)` (0.5, 1.0, 2.0…).
 */
export function percentToScale(percent: number): number {
    return percent / 100;
}
