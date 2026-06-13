// Unit tests for the PPT zoom-ladder helpers (issue #49).
//
// Coverage:
//   - The discrete ladder has exactly 6 steps, monotonically increasing,
//     starting at 50% and ending at 200% (issue #49 spec — the
//     50/75/100/125/150/200 ladder).
//   - `nextZoom` / `prevZoom` walk the ladder one step at a time and
//     clamp at the ends.
//   - `nearestZoomIndex` snaps off-ladder values to the closest level.
//   - `clampZoom` constrains arbitrary numbers to [min, max] without
//     snapping to a ladder level (and falls back to the default for
//     non-finite inputs).
//   - `formatZoomLabel` produces the trailing-`%` format the toolbar uses.
//   - `canZoomIn` / `canZoomOut` correctly report whether a step is
//     possible (so the buttons can disable themselves at the edges).
//   - `percentToScale` converts to the multiplier `transform: scale(...)`
//     expects.
//
// These tests run without a DOM and without JSZip — the helpers are
// intentionally pure so the math is testable in isolation.

import {
    PPT_DEFAULT_ZOOM_PERCENT,
    PPT_MAX_ZOOM_PERCENT,
    PPT_MIN_ZOOM_PERCENT,
    PPT_ZOOM_LEVELS_PERCENT,
    canZoomIn,
    canZoomOut,
    clampZoom,
    formatZoomLabel,
    nearestZoomIndex,
    nextZoom,
    percentToScale,
    prevZoom
} from '../templates/ppt/js/pptZoom';

describe('PPT_ZOOM_LEVELS_PERCENT', () => {
    it('matches the issue #49 ladder exactly', () => {
        expect([...PPT_ZOOM_LEVELS_PERCENT]).toEqual([
            50, 75, 100, 125, 150, 200
        ]);
    });

    it('has exactly 6 steps (issue #49)', () => {
        expect(PPT_ZOOM_LEVELS_PERCENT).toHaveLength(6);
    });

    it('starts at 50% and ends at 200% (issue #49 spec)', () => {
        expect(PPT_ZOOM_LEVELS_PERCENT[0]).toBe(50);
        expect(
            PPT_ZOOM_LEVELS_PERCENT[PPT_ZOOM_LEVELS_PERCENT.length - 1]
        ).toBe(200);
    });

    it('is monotonically increasing', () => {
        for (let i = 1; i < PPT_ZOOM_LEVELS_PERCENT.length; i++) {
            expect(PPT_ZOOM_LEVELS_PERCENT[i]).toBeGreaterThan(
                PPT_ZOOM_LEVELS_PERCENT[i - 1]
            );
        }
    });

    it('uses 100% as the default and includes it on the ladder', () => {
        expect(PPT_DEFAULT_ZOOM_PERCENT).toBe(100);
        expect(PPT_ZOOM_LEVELS_PERCENT).toContain(PPT_DEFAULT_ZOOM_PERCENT);
    });

    it('exposes consistent min/max constants', () => {
        expect(PPT_MIN_ZOOM_PERCENT).toBe(PPT_ZOOM_LEVELS_PERCENT[0]);
        expect(PPT_MAX_ZOOM_PERCENT).toBe(
            PPT_ZOOM_LEVELS_PERCENT[PPT_ZOOM_LEVELS_PERCENT.length - 1]
        );
        expect(PPT_MIN_ZOOM_PERCENT).toBe(50);
        expect(PPT_MAX_ZOOM_PERCENT).toBe(200);
    });
});

describe('clampZoom', () => {
    it('returns the value unchanged when within range', () => {
        expect(clampZoom(50)).toBe(50);
        expect(clampZoom(100)).toBe(100);
        expect(clampZoom(123)).toBe(123); // not on the ladder, but within range
        expect(clampZoom(200)).toBe(200);
    });

    it('clamps below the lowest level', () => {
        expect(clampZoom(0)).toBe(50);
        expect(clampZoom(-100)).toBe(50);
        expect(clampZoom(49.9)).toBe(50);
    });

    it('clamps above the highest level', () => {
        expect(clampZoom(250)).toBe(200);
        expect(clampZoom(1000)).toBe(200);
    });

    it('falls back to the default for non-finite input', () => {
        expect(clampZoom(Number.NaN)).toBe(PPT_DEFAULT_ZOOM_PERCENT);
        expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(
            PPT_DEFAULT_ZOOM_PERCENT
        );
        expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(
            PPT_DEFAULT_ZOOM_PERCENT
        );
    });
});

describe('nearestZoomIndex', () => {
    it('returns the exact index when given a level value', () => {
        expect(nearestZoomIndex(50)).toBe(0);
        expect(nearestZoomIndex(100)).toBe(2);
        expect(nearestZoomIndex(200)).toBe(PPT_ZOOM_LEVELS_PERCENT.length - 1);
    });

    it('snaps off-ladder values to the nearest level', () => {
        // 110% is closer to 100 (delta 10) than to 125 (delta 15).
        expect(PPT_ZOOM_LEVELS_PERCENT[nearestZoomIndex(110)]).toBe(100);
        // 180% is closer to 200 (delta 20) than to 150 (delta 30).
        expect(PPT_ZOOM_LEVELS_PERCENT[nearestZoomIndex(180)]).toBe(200);
        // 60% is closer to 50 (delta 10) than to 75 (delta 15).
        expect(PPT_ZOOM_LEVELS_PERCENT[nearestZoomIndex(60)]).toBe(50);
    });

    it('clamps below the lowest level', () => {
        expect(nearestZoomIndex(10)).toBe(0);
        expect(nearestZoomIndex(0)).toBe(0);
    });

    it('clamps above the highest level', () => {
        expect(nearestZoomIndex(500)).toBe(PPT_ZOOM_LEVELS_PERCENT.length - 1);
        expect(nearestZoomIndex(1000)).toBe(
            PPT_ZOOM_LEVELS_PERCENT.length - 1
        );
    });
});

describe('nextZoom', () => {
    it('walks the ladder one step at a time', () => {
        expect(nextZoom(50)).toBe(75);
        expect(nextZoom(75)).toBe(100);
        expect(nextZoom(100)).toBe(125);
        expect(nextZoom(125)).toBe(150);
        expect(nextZoom(150)).toBe(200);
    });

    it('clamps at the top of the ladder', () => {
        expect(nextZoom(200)).toBe(200);
    });

    it('snaps off-ladder values then steps up', () => {
        // 110 -> nearest 100 (idx 2) -> next is 125
        expect(nextZoom(110)).toBe(125);
        // 180 -> nearest 200 (top) -> stays at 200
        expect(nextZoom(180)).toBe(200);
    });
});

describe('prevZoom', () => {
    it('walks the ladder one step at a time', () => {
        expect(prevZoom(200)).toBe(150);
        expect(prevZoom(150)).toBe(125);
        expect(prevZoom(125)).toBe(100);
        expect(prevZoom(100)).toBe(75);
        expect(prevZoom(75)).toBe(50);
    });

    it('clamps at the bottom of the ladder', () => {
        expect(prevZoom(50)).toBe(50);
    });

    it('snaps off-ladder values then steps down', () => {
        // 110 -> nearest 100 (idx 2) -> previous is 75
        expect(prevZoom(110)).toBe(75);
        // 60 -> nearest 50 -> previous is 50 (clamp)
        expect(prevZoom(60)).toBe(50);
    });
});

describe('full asc/desc walk over the ladder', () => {
    it('nextZoom, called repeatedly, lands on every level once', () => {
        const seen: number[] = [];
        let p = PPT_ZOOM_LEVELS_PERCENT[0];
        seen.push(p);
        for (
            let i = 0;
            i < 100 &&
            p !== PPT_ZOOM_LEVELS_PERCENT[PPT_ZOOM_LEVELS_PERCENT.length - 1];
            i++
        ) {
            p = nextZoom(p);
            seen.push(p);
        }
        expect(seen).toEqual([...PPT_ZOOM_LEVELS_PERCENT]);
    });

    it('prevZoom, called repeatedly, lands on every level once', () => {
        const seen: number[] = [];
        let p = PPT_ZOOM_LEVELS_PERCENT[PPT_ZOOM_LEVELS_PERCENT.length - 1];
        seen.push(p);
        for (
            let i = 0;
            i < 100 && p !== PPT_ZOOM_LEVELS_PERCENT[0];
            i++
        ) {
            p = prevZoom(p);
            seen.push(p);
        }
        expect(seen).toEqual([...PPT_ZOOM_LEVELS_PERCENT].reverse());
    });
});

describe('canZoomIn / canZoomOut', () => {
    it('returns false at the respective edges', () => {
        expect(canZoomOut(50)).toBe(false);
        expect(canZoomIn(200)).toBe(false);
    });

    it('returns true when there is headroom in each direction', () => {
        expect(canZoomIn(50)).toBe(true);
        expect(canZoomOut(200)).toBe(true);
        expect(canZoomIn(100)).toBe(true);
        expect(canZoomOut(100)).toBe(true);
    });
});

describe('formatZoomLabel', () => {
    it('renders the percent with a trailing %', () => {
        expect(formatZoomLabel(50)).toBe('50%');
        expect(formatZoomLabel(100)).toBe('100%');
        expect(formatZoomLabel(200)).toBe('200%');
    });

    it('rounds non-integer inputs', () => {
        expect(formatZoomLabel(99.4)).toBe('99%');
        expect(formatZoomLabel(99.6)).toBe('100%');
    });
});

describe('percentToScale', () => {
    it('converts ladder values to CSS scale multipliers', () => {
        expect(percentToScale(50)).toBe(0.5);
        expect(percentToScale(100)).toBe(1);
        expect(percentToScale(125)).toBe(1.25);
        expect(percentToScale(200)).toBe(2);
    });
});
