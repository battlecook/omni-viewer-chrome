// Unit tests for the Word zoom-ladder helpers (issue #43).
//
// Coverage:
//   - The discrete ladder has exactly 10 steps, monotonically increasing,
//     starting at 50% and ending at 250% (issue #43 spec).
//   - `nextZoom` / `prevZoom` walk the ladder one step at a time and
//     clamp at the ends.
//   - `nearestZoomIndex` snaps off-ladder values to the closest level.
//   - `clampZoom` constrains arbitrary numbers to [min, max] without
//     snapping to a ladder level.
//   - `formatZoomLabel` produces the trailing-`%` format the toolbar uses.
//   - `canZoomIn` / `canZoomOut` correctly report whether a step is
//     possible (so the buttons can disable themselves at the edges).
//   - `percentToScale` converts to the multiplier `transform: scale(...)`
//     expects.
//
// These tests run without a DOM and without docx-preview — the helpers
// are intentionally pure so the math is testable in isolation.

import {
    canZoomIn,
    canZoomOut,
    clampZoom,
    formatZoomLabel,
    nearestZoomIndex,
    nextZoom,
    percentToScale,
    prevZoom,
    WORD_DEFAULT_ZOOM_PERCENT,
    WORD_MAX_ZOOM_PERCENT,
    WORD_MIN_ZOOM_PERCENT,
    WORD_ZOOM_LEVELS_PERCENT
} from '../templates/word/js/wordZoom';

describe('WORD_ZOOM_LEVELS_PERCENT', () => {
    it('has exactly 10 steps (issue #43)', () => {
        expect(WORD_ZOOM_LEVELS_PERCENT).toHaveLength(10);
    });

    it('starts at 50% and ends at 250% (issue #43 spec)', () => {
        expect(WORD_ZOOM_LEVELS_PERCENT[0]).toBe(50);
        expect(
            WORD_ZOOM_LEVELS_PERCENT[WORD_ZOOM_LEVELS_PERCENT.length - 1]
        ).toBe(250);
    });

    it('is monotonically increasing', () => {
        for (let i = 1; i < WORD_ZOOM_LEVELS_PERCENT.length; i++) {
            expect(WORD_ZOOM_LEVELS_PERCENT[i]).toBeGreaterThan(
                WORD_ZOOM_LEVELS_PERCENT[i - 1]
            );
        }
    });

    it('uses 100% as the default and includes it on the ladder', () => {
        expect(WORD_DEFAULT_ZOOM_PERCENT).toBe(100);
        expect(WORD_ZOOM_LEVELS_PERCENT).toContain(WORD_DEFAULT_ZOOM_PERCENT);
    });

    it('exposes consistent min/max constants', () => {
        expect(WORD_MIN_ZOOM_PERCENT).toBe(WORD_ZOOM_LEVELS_PERCENT[0]);
        expect(WORD_MAX_ZOOM_PERCENT).toBe(
            WORD_ZOOM_LEVELS_PERCENT[WORD_ZOOM_LEVELS_PERCENT.length - 1]
        );
        expect(WORD_MIN_ZOOM_PERCENT).toBe(50);
        expect(WORD_MAX_ZOOM_PERCENT).toBe(250);
    });
});

describe('clampZoom', () => {
    it('returns the value unchanged when within range', () => {
        expect(clampZoom(50)).toBe(50);
        expect(clampZoom(100)).toBe(100);
        expect(clampZoom(123)).toBe(123); // not on the ladder, but within range
        expect(clampZoom(250)).toBe(250);
    });

    it('clamps below the lowest level', () => {
        expect(clampZoom(0)).toBe(50);
        expect(clampZoom(-100)).toBe(50);
        expect(clampZoom(49.9)).toBe(50);
    });

    it('clamps above the highest level', () => {
        expect(clampZoom(300)).toBe(250);
        expect(clampZoom(1000)).toBe(250);
    });

    it('falls back to the default for non-finite input', () => {
        expect(clampZoom(Number.NaN)).toBe(WORD_DEFAULT_ZOOM_PERCENT);
        expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(
            WORD_DEFAULT_ZOOM_PERCENT
        );
        expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(
            WORD_DEFAULT_ZOOM_PERCENT
        );
    });
});

describe('nearestZoomIndex', () => {
    it('returns the exact index when given a level value', () => {
        expect(nearestZoomIndex(50)).toBe(0);
        expect(nearestZoomIndex(100)).toBe(3);
        expect(nearestZoomIndex(250)).toBe(WORD_ZOOM_LEVELS_PERCENT.length - 1);
    });

    it('snaps off-ladder values to the nearest level', () => {
        // 110% is closer to 100 (delta 10) than to 125 (delta 15).
        expect(WORD_ZOOM_LEVELS_PERCENT[nearestZoomIndex(110)]).toBe(100);
        // 140% is closer to 150 (delta 10) than to 125 (delta 15).
        expect(WORD_ZOOM_LEVELS_PERCENT[nearestZoomIndex(140)]).toBe(150);
        // 240% is closer to 250 (delta 10) than to 225 (delta 15).
        expect(WORD_ZOOM_LEVELS_PERCENT[nearestZoomIndex(240)]).toBe(250);
    });

    it('clamps below the lowest level', () => {
        expect(nearestZoomIndex(10)).toBe(0);
        expect(nearestZoomIndex(0)).toBe(0);
    });

    it('clamps above the highest level', () => {
        expect(nearestZoomIndex(500)).toBe(WORD_ZOOM_LEVELS_PERCENT.length - 1);
        expect(nearestZoomIndex(1000)).toBe(
            WORD_ZOOM_LEVELS_PERCENT.length - 1
        );
    });
});

describe('nextZoom', () => {
    it('walks the ladder one step at a time', () => {
        let current = WORD_ZOOM_LEVELS_PERCENT[0];
        for (let i = 1; i < WORD_ZOOM_LEVELS_PERCENT.length; i++) {
            current = nextZoom(current);
            expect(current).toBe(WORD_ZOOM_LEVELS_PERCENT[i]);
        }
    });

    it('clamps at the top of the ladder', () => {
        expect(nextZoom(250)).toBe(250);
    });

    it('snaps off-ladder values then steps up', () => {
        // 110 -> nearest 100 (idx 3) -> next is 125
        expect(nextZoom(110)).toBe(125);
        // 240 -> nearest 250 (top) -> stays at 250
        expect(nextZoom(240)).toBe(250);
    });
});

describe('prevZoom', () => {
    it('walks the ladder one step at a time', () => {
        let current =
            WORD_ZOOM_LEVELS_PERCENT[WORD_ZOOM_LEVELS_PERCENT.length - 1];
        for (let i = WORD_ZOOM_LEVELS_PERCENT.length - 2; i >= 0; i--) {
            current = prevZoom(current);
            expect(current).toBe(WORD_ZOOM_LEVELS_PERCENT[i]);
        }
    });

    it('clamps at the bottom of the ladder', () => {
        expect(prevZoom(50)).toBe(50);
    });

    it('snaps off-ladder values then steps down', () => {
        // 110 -> nearest 100 (idx 3) -> previous is 75
        expect(prevZoom(110)).toBe(75);
        // 55 -> nearest 50 -> previous is 50 (clamp)
        expect(prevZoom(55)).toBe(50);
    });
});

describe('full asc/desc walk over the ladder', () => {
    it('nextZoom, called repeatedly, lands on every level once', () => {
        const seen: number[] = [];
        let p = WORD_ZOOM_LEVELS_PERCENT[0];
        seen.push(p);
        for (
            let i = 0;
            i < 100 &&
            p !==
                WORD_ZOOM_LEVELS_PERCENT[WORD_ZOOM_LEVELS_PERCENT.length - 1];
            i++
        ) {
            p = nextZoom(p);
            seen.push(p);
        }
        expect(seen).toEqual([...WORD_ZOOM_LEVELS_PERCENT]);
    });

    it('prevZoom, called repeatedly, lands on every level once', () => {
        const seen: number[] = [];
        let p = WORD_ZOOM_LEVELS_PERCENT[WORD_ZOOM_LEVELS_PERCENT.length - 1];
        seen.push(p);
        for (
            let i = 0;
            i < 100 && p !== WORD_ZOOM_LEVELS_PERCENT[0];
            i++
        ) {
            p = prevZoom(p);
            seen.push(p);
        }
        expect(seen).toEqual([...WORD_ZOOM_LEVELS_PERCENT].reverse());
    });
});

describe('canZoomIn / canZoomOut', () => {
    it('returns false at the respective edges', () => {
        expect(canZoomOut(50)).toBe(false);
        expect(canZoomIn(250)).toBe(false);
    });

    it('returns true when there is headroom in each direction', () => {
        expect(canZoomIn(50)).toBe(true);
        expect(canZoomOut(250)).toBe(true);
        expect(canZoomIn(100)).toBe(true);
        expect(canZoomOut(100)).toBe(true);
    });
});

describe('formatZoomLabel', () => {
    it('renders the percent with a trailing %', () => {
        expect(formatZoomLabel(50)).toBe('50%');
        expect(formatZoomLabel(100)).toBe('100%');
        expect(formatZoomLabel(250)).toBe('250%');
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
        expect(percentToScale(250)).toBe(2.5);
    });
});
