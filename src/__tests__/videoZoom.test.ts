// Unit tests for the video zoom-ladder helpers (issue #30).
//
// Coverage mirrors `pdfZoom.test.ts` (issue #16) so the video viewer's zoom
// behaviour stays consistent with the PDF / Word / image viewers:
//
//   - The discrete ladder matches the issue spec (50/75/100/125/150/200/300).
//   - `nextZoom` / `prevZoom` walk the ladder one step at a time and clamp
//     at the ends.
//   - `nearestZoomIndex` snaps off-ladder values to the closest level.
//   - `formatZoomLabel` produces the trailing-`%` format the toolbar uses.
//   - `canZoomIn` / `canZoomOut` correctly report whether a step is
//     possible (so the buttons can disable themselves at the edges).
//   - `percentToScale` converts to the CSS `transform: scale()` multiplier.
//   - `computeFitZoomPercent` derives a fit-to-container percent that
//     respects aspect ratio and clamps into the ladder bounds.
//
// All helpers are pure (no DOM, no `<video>`) so the tests run under the
// repo's existing jest setup without jsdom hooks.

import {
    canZoomIn,
    canZoomOut,
    computeFitZoomPercent,
    DEFAULT_ZOOM_PERCENT,
    formatZoomLabel,
    nearestZoomIndex,
    nextZoom,
    percentToScale,
    prevZoom,
    ZOOM_LEVELS_PERCENT
} from '../templates/video/js/videoUtils';

describe('ZOOM_LEVELS_PERCENT', () => {
    it('matches the issue #30 ladder exactly', () => {
        expect([...ZOOM_LEVELS_PERCENT]).toEqual([
            50, 75, 100, 125, 150, 200, 300
        ]);
    });

    it('is monotonically increasing', () => {
        for (let i = 1; i < ZOOM_LEVELS_PERCENT.length; i++) {
            expect(ZOOM_LEVELS_PERCENT[i]).toBeGreaterThan(
                ZOOM_LEVELS_PERCENT[i - 1]
            );
        }
    });

    it('uses 100% as the default', () => {
        expect(DEFAULT_ZOOM_PERCENT).toBe(100);
        expect(ZOOM_LEVELS_PERCENT).toContain(DEFAULT_ZOOM_PERCENT);
    });
});

describe('nearestZoomIndex', () => {
    it('returns the exact index when given a level value', () => {
        expect(nearestZoomIndex(50)).toBe(0);
        expect(nearestZoomIndex(100)).toBe(2);
        expect(nearestZoomIndex(300)).toBe(6);
    });

    it('snaps off-ladder values to the nearest level', () => {
        // 110% is closer to 100 (delta 10) than to 125 (delta 15).
        expect(nearestZoomIndex(110)).toBe(2);
        // 180% is closer to 200 (delta 20) than to 150 (delta 30).
        expect(nearestZoomIndex(180)).toBe(5);
        // 60% is closer to 50 (delta 10) than to 75 (delta 15).
        expect(nearestZoomIndex(60)).toBe(0);
    });

    it('clamps below the lowest level', () => {
        expect(nearestZoomIndex(10)).toBe(0);
        expect(nearestZoomIndex(0)).toBe(0);
    });

    it('clamps above the highest level', () => {
        expect(nearestZoomIndex(500)).toBe(6);
        expect(nearestZoomIndex(1000)).toBe(6);
    });

    it('falls back to the default index for non-finite input', () => {
        // Index of 100% in the ladder is 2.
        expect(nearestZoomIndex(Number.NaN)).toBe(2);
        expect(nearestZoomIndex(Number.POSITIVE_INFINITY)).toBe(2);
        expect(nearestZoomIndex(Number.NEGATIVE_INFINITY)).toBe(2);
    });
});

describe('nextZoom', () => {
    it('walks the ladder one step at a time', () => {
        expect(nextZoom(50)).toBe(75);
        expect(nextZoom(75)).toBe(100);
        expect(nextZoom(100)).toBe(125);
        expect(nextZoom(125)).toBe(150);
        expect(nextZoom(150)).toBe(200);
        expect(nextZoom(200)).toBe(300);
    });

    it('clamps at the top of the ladder', () => {
        expect(nextZoom(300)).toBe(300);
    });

    it('snaps off-ladder values then steps up', () => {
        // 110 -> nearest 100 -> next is 125
        expect(nextZoom(110)).toBe(125);
        // 180 -> nearest 200 -> next is 300
        expect(nextZoom(180)).toBe(300);
    });
});

describe('prevZoom', () => {
    it('walks the ladder one step at a time', () => {
        expect(prevZoom(300)).toBe(200);
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
        // 110 -> nearest 100 -> previous is 75
        expect(prevZoom(110)).toBe(75);
        // 60 -> nearest 50 -> previous is 50 (clamp)
        expect(prevZoom(60)).toBe(50);
    });
});

describe('full asc/desc walk over the ladder', () => {
    it('nextZoom, called repeatedly, lands on every level once', () => {
        const seen: number[] = [];
        let p = ZOOM_LEVELS_PERCENT[0];
        seen.push(p);
        // We loop a bounded number of times so a regression in the clamp
        // logic doesn't hang the test.
        for (
            let i = 0;
            i < 100 &&
            p !== ZOOM_LEVELS_PERCENT[ZOOM_LEVELS_PERCENT.length - 1];
            i++
        ) {
            p = nextZoom(p);
            seen.push(p);
        }
        expect(seen).toEqual([...ZOOM_LEVELS_PERCENT]);
    });

    it('prevZoom, called repeatedly, lands on every level once', () => {
        const seen: number[] = [];
        let p = ZOOM_LEVELS_PERCENT[ZOOM_LEVELS_PERCENT.length - 1];
        seen.push(p);
        for (let i = 0; i < 100 && p !== ZOOM_LEVELS_PERCENT[0]; i++) {
            p = prevZoom(p);
            seen.push(p);
        }
        expect(seen).toEqual([...ZOOM_LEVELS_PERCENT].reverse());
    });
});

describe('canZoomIn / canZoomOut', () => {
    it('returns false at the respective edges', () => {
        expect(canZoomOut(50)).toBe(false);
        expect(canZoomIn(300)).toBe(false);
    });

    it('returns true when there is headroom in each direction', () => {
        expect(canZoomIn(50)).toBe(true);
        expect(canZoomOut(300)).toBe(true);
        expect(canZoomIn(100)).toBe(true);
        expect(canZoomOut(100)).toBe(true);
    });
});

describe('formatZoomLabel', () => {
    it('renders the percent with a trailing %', () => {
        expect(formatZoomLabel(50)).toBe('50%');
        expect(formatZoomLabel(100)).toBe('100%');
        expect(formatZoomLabel(300)).toBe('300%');
    });

    it('rounds non-integer inputs', () => {
        expect(formatZoomLabel(99.4)).toBe('99%');
        expect(formatZoomLabel(99.6)).toBe('100%');
    });

    it('falls back to the default for non-finite input', () => {
        expect(formatZoomLabel(Number.NaN)).toBe('100%');
    });
});

describe('percentToScale', () => {
    it('converts ladder values to CSS scale multipliers', () => {
        expect(percentToScale(50)).toBe(0.5);
        expect(percentToScale(100)).toBe(1);
        expect(percentToScale(125)).toBe(1.25);
        expect(percentToScale(300)).toBe(3);
    });

    it('returns 1 for invalid inputs', () => {
        expect(percentToScale(0)).toBe(1);
        expect(percentToScale(-50)).toBe(1);
        expect(percentToScale(Number.NaN)).toBe(1);
    });
});

describe('computeFitZoomPercent', () => {
    it('returns the larger-axis-limited percent for a normal video', () => {
        // 1920x1080 video in a 960x720 container: width is the binding
        // dimension (960/1920 = 0.5), so fit is 50%.
        expect(computeFitZoomPercent(1920, 1080, 960, 720)).toBe(50);
    });

    it('uses height as the binding dimension when it is the tighter axis', () => {
        // 1000x1000 in 800x500 -> 500/1000 = 0.5
        expect(computeFitZoomPercent(1000, 1000, 800, 500)).toBe(50);
    });

    it('returns 100 when the video already fits exactly', () => {
        expect(computeFitZoomPercent(640, 480, 640, 480)).toBe(100);
    });

    it('clamps oversized fit at 300%', () => {
        // 100x100 video in 1000x1000 container would imply 1000% fit.
        expect(computeFitZoomPercent(100, 100, 1000, 1000)).toBe(300);
    });

    it('clamps undersized fit at 50%', () => {
        // 10000x10000 video in 100x100 container would imply 1% fit.
        expect(computeFitZoomPercent(10000, 10000, 100, 100)).toBe(50);
    });

    it('returns the default 100 for invalid inputs', () => {
        expect(computeFitZoomPercent(0, 1080, 960, 720)).toBe(100);
        expect(computeFitZoomPercent(1920, 0, 960, 720)).toBe(100);
        expect(computeFitZoomPercent(1920, 1080, 0, 720)).toBe(100);
        expect(computeFitZoomPercent(1920, 1080, 960, 0)).toBe(100);
        expect(computeFitZoomPercent(Number.NaN, 1080, 960, 720)).toBe(100);
    });
});
