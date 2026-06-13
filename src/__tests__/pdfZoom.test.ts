// Unit tests for the PDF zoom-ladder helpers (issue #16).
//
// Coverage:
//   - The discrete ladder matches the issue spec (50/75/100/125/150/200/300).
//   - `zoomInStep` / `zoomOutStep` walk the ladder one step at a time and
//     clamp at the ends.
//   - `nearestZoomIndex` snaps off-ladder values to the closest level.
//   - `formatZoomLabel` produces the trailing-`%` format the toolbar uses.
//   - `canZoomIn` / `canZoomOut` correctly report whether a step is
//     possible (so the buttons can disable themselves at the edges).
//   - `percentToScale` converts to the multiplier pdf.js expects.
//
// These tests run without a DOM and without pdf.js — the helpers are
// intentionally pure so the math is testable in isolation.

import {
    canZoomIn,
    canZoomOut,
    DEFAULT_ZOOM_PERCENT,
    formatZoomLabel,
    nearestZoomIndex,
    percentToScale,
    zoomInStep,
    zoomOutStep,
    ZOOM_LEVELS_PERCENT
} from '../templates/pdf/js/pdfZoom';

describe('ZOOM_LEVELS_PERCENT', () => {
    it('matches the issue #16 ladder exactly', () => {
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
});

describe('zoomInStep', () => {
    it('walks the ladder one step at a time', () => {
        expect(zoomInStep(50)).toBe(75);
        expect(zoomInStep(75)).toBe(100);
        expect(zoomInStep(100)).toBe(125);
        expect(zoomInStep(125)).toBe(150);
        expect(zoomInStep(150)).toBe(200);
        expect(zoomInStep(200)).toBe(300);
    });

    it('clamps at the top of the ladder', () => {
        expect(zoomInStep(300)).toBe(300);
    });

    it('snaps off-ladder values then steps up', () => {
        // 110 -> nearest 100 -> next is 125
        expect(zoomInStep(110)).toBe(125);
        // 180 -> nearest 200 -> next is 300
        expect(zoomInStep(180)).toBe(300);
    });
});

describe('zoomOutStep', () => {
    it('walks the ladder one step at a time', () => {
        expect(zoomOutStep(300)).toBe(200);
        expect(zoomOutStep(200)).toBe(150);
        expect(zoomOutStep(150)).toBe(125);
        expect(zoomOutStep(125)).toBe(100);
        expect(zoomOutStep(100)).toBe(75);
        expect(zoomOutStep(75)).toBe(50);
    });

    it('clamps at the bottom of the ladder', () => {
        expect(zoomOutStep(50)).toBe(50);
    });

    it('snaps off-ladder values then steps down', () => {
        // 110 -> nearest 100 -> previous is 75
        expect(zoomOutStep(110)).toBe(75);
        // 60 -> nearest 50 -> previous is 50 (clamp)
        expect(zoomOutStep(60)).toBe(50);
    });
});

describe('full asc/desc walk over the ladder', () => {
    it('zoomInStep, called repeatedly, lands on every level once', () => {
        const seen: number[] = [];
        let p = ZOOM_LEVELS_PERCENT[0];
        seen.push(p);
        // We loop a bounded number of times so a regression in the clamp
        // logic doesn't hang the test.
        for (let i = 0; i < 100 && p !== ZOOM_LEVELS_PERCENT[ZOOM_LEVELS_PERCENT.length - 1]; i++) {
            p = zoomInStep(p);
            seen.push(p);
        }
        expect(seen).toEqual([...ZOOM_LEVELS_PERCENT]);
    });

    it('zoomOutStep, called repeatedly, lands on every level once', () => {
        const seen: number[] = [];
        let p = ZOOM_LEVELS_PERCENT[ZOOM_LEVELS_PERCENT.length - 1];
        seen.push(p);
        for (let i = 0; i < 100 && p !== ZOOM_LEVELS_PERCENT[0]; i++) {
            p = zoomOutStep(p);
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
});

describe('percentToScale', () => {
    it('converts ladder values to pdf.js scale multipliers', () => {
        expect(percentToScale(50)).toBe(0.5);
        expect(percentToScale(100)).toBe(1);
        expect(percentToScale(125)).toBe(1.25);
        expect(percentToScale(300)).toBe(3);
    });
});
