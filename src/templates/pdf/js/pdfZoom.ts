// Zoom-level state machine for the Chrome PDF viewer.
//
// VSCode reference: `vscode-omni-viewer/src/templates/pdf/js/pdfViewer.js`
// uses MIN_SCALE / MAX_SCALE / SCALE_STEP (0.5 / 3 / 0.25) which produces a
// continuous 50 / 75 / 100 / 125 / 150 / 175 / 200 / 225 / 250 / 275 / 300
// ladder. Issue #16 explicitly pins the steps to the discrete sequence
// 50 / 75 / 100 / 125 / 150 / 200 / 300, so this module is the
// authoritative source for the ladder rather than the VSCode constants.
//
// All math is intentionally kept side-effect free so it can be unit tested
// without a DOM / pdf.js (`src/__tests__/pdfZoom.test.ts`).

/**
 * Discrete zoom levels from issue #16, expressed as percentages. The
 * sequence is monotonically increasing — `zoomInStep` / `zoomOutStep`
 * both rely on that ordering.
 */
export const ZOOM_LEVELS_PERCENT: readonly number[] = [
    50, 75, 100, 125, 150, 200, 300
] as const;

/**
 * Default zoom percent (100%). Pulled out as a constant so the entry can
 * import it once instead of indexing into `ZOOM_LEVELS_PERCENT` ad hoc.
 */
export const DEFAULT_ZOOM_PERCENT = 100;

/**
 * Convert a zoom-percent (50, 75, 100…) to the multiplier pdf.js's
 * `getViewport({ scale })` expects (0.5, 0.75, 1.0…).
 */
export function percentToScale(percent: number): number {
    return percent / 100;
}

/**
 * Find the index of `percent` inside `ZOOM_LEVELS_PERCENT`. If it is not
 * an exact match, returns the index of the nearest level. Used internally
 * to recover from "set zoom to an arbitrary value, now where am I in the
 * ladder?" — keeps the step navigation deterministic.
 */
export function nearestZoomIndex(percent: number): number {
    let bestIdx = 0;
    let bestDelta = Math.abs(ZOOM_LEVELS_PERCENT[0] - percent);
    for (let i = 1; i < ZOOM_LEVELS_PERCENT.length; i++) {
        const delta = Math.abs(ZOOM_LEVELS_PERCENT[i] - percent);
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
export function zoomInStep(currentPercent: number): number {
    const idx = nearestZoomIndex(currentPercent);
    const nextIdx = Math.min(idx + 1, ZOOM_LEVELS_PERCENT.length - 1);
    return ZOOM_LEVELS_PERCENT[nextIdx];
}

/**
 * Step down: returns the next-lower zoom level, or the current value if
 * already at the bottom of the ladder.
 */
export function zoomOutStep(currentPercent: number): number {
    const idx = nearestZoomIndex(currentPercent);
    const prevIdx = Math.max(idx - 1, 0);
    return ZOOM_LEVELS_PERCENT[prevIdx];
}

/**
 * Format a zoom percent into the label used by `#zoomLevel`. Centralized so
 * the renderer and the entry agree on the rendering (e.g. trailing `%`).
 */
export function formatZoomLabel(percent: number): string {
    return `${Math.round(percent)}%`;
}

/**
 * Returns true when stepping down would change the value — used to decide
 * whether to disable the `−` button.
 */
export function canZoomOut(percent: number): boolean {
    return nearestZoomIndex(percent) > 0;
}

/**
 * Returns true when stepping up would change the value — used to decide
 * whether to disable the `+` button.
 */
export function canZoomIn(percent: number): boolean {
    return nearestZoomIndex(percent) < ZOOM_LEVELS_PERCENT.length - 1;
}
