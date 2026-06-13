// ColorUtils — minimum stubs for issue #11.
//
// Issue #11 does not draw any colored elements; ColorUtils only exists at
// this stage as a port of the VSCode reference so #12 (element creation)
// and #14 (properties panel) have a known landing spot. We ship the two
// helpers that are pure / deterministic and have unit-testable behavior:
//   - `hexToRgba` — used by the future text/shape style updaters
//   - `isTransparent` — used by future opacity comparisons
//
// `getCommonColor` (multi-selection averaging) lives in #14's
// PropertiesPanel territory and will land alongside selection.

/**
 * Convert a hex color string (`#rrggbb` or `rrggbb`) to a CSS rgba()
 * string. Invalid input falls back to opaque black so callers can't crash
 * the viewer with malformed user data.
 */
export function hexToRgba(hex: string, alpha: number): string {
    const cleaned = hex.replace('#', '');
    if (cleaned.length !== 6 || /[^0-9a-fA-F]/.test(cleaned)) {
        return `rgba(0, 0, 0, ${clamp01(alpha)})`;
    }
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
}

/** Test whether a color value should render as fully transparent. */
export function isTransparent(color: string): boolean {
    return color === 'transparent'
        || color === '#00000000'
        || color === 'rgba(0,0,0,0)'
        || color === 'rgba(0, 0, 0, 0)';
}

function clamp01(value: number): number {
    if (Number.isNaN(value)) return 1;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}
