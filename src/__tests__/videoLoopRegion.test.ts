// Unit tests for issue #29: Video loop-region + playback speed + skip ±10s.
//
// The pure-helper surface added to `src/templates/video/js/videoUtils.ts`:
//   - `PLAYBACK_SPEEDS`        — canonical 8-step ladder
//   - `DEFAULT_PLAYBACK_SPEED` — initial rate (1)
//   - `nextSpeed(current, dir)` — ladder navigation with edge saturation
//   - `clampTime(t, duration)`  — ±10s skip clamp into [0, duration]
//   - `loopShouldRestart(t, a?, b?)` — predicate the timeupdate handler uses
//
// These tests cover the DoD signal: "8 speed steps accurate" + "A/B loop
// runs without audio drift" (which boils down to the predicate firing only
// when both markers are set and `b > a`).

import {
    PLAYBACK_SPEEDS,
    DEFAULT_PLAYBACK_SPEED,
    nextSpeed,
    clampTime,
    loopShouldRestart
} from '../templates/video/js/videoUtils';

describe('videoUtils — PLAYBACK_SPEEDS ladder (DoD: 8 speed steps)', () => {
    it('exposes the 8 canonical playback rates in ascending order', () => {
        expect(PLAYBACK_SPEEDS).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4]);
        expect(PLAYBACK_SPEEDS).toHaveLength(8);
    });

    it('is strictly increasing', () => {
        for (let i = 1; i < PLAYBACK_SPEEDS.length; i++) {
            expect(PLAYBACK_SPEEDS[i]).toBeGreaterThan(PLAYBACK_SPEEDS[i - 1]);
        }
    });

    it('default speed is 1 and lives on the ladder', () => {
        expect(DEFAULT_PLAYBACK_SPEED).toBe(1);
        expect(PLAYBACK_SPEEDS).toContain(DEFAULT_PLAYBACK_SPEED);
    });
});

describe('videoUtils — nextSpeed', () => {
    it('steps up from 1x to 1.25x', () => {
        expect(nextSpeed(1, 1)).toBe(1.25);
    });

    it('steps down from 1x to 0.75x', () => {
        expect(nextSpeed(1, -1)).toBe(0.75);
    });

    it('saturates at the slow end (0.25)', () => {
        expect(nextSpeed(0.25, -1)).toBe(0.25);
    });

    it('saturates at the fast end (4)', () => {
        expect(nextSpeed(4, 1)).toBe(4);
    });

    it('walks the entire ladder upward without skipping a step', () => {
        let s = PLAYBACK_SPEEDS[0];
        const visited = [s];
        for (let i = 1; i < PLAYBACK_SPEEDS.length; i++) {
            s = nextSpeed(s, 1);
            visited.push(s);
        }
        expect(visited).toEqual(Array.from(PLAYBACK_SPEEDS));
    });

    it('walks the entire ladder downward without skipping a step', () => {
        let s = PLAYBACK_SPEEDS[PLAYBACK_SPEEDS.length - 1];
        const visited = [s];
        for (let i = PLAYBACK_SPEEDS.length - 2; i >= 0; i--) {
            s = nextSpeed(s, -1);
            visited.push(s);
        }
        expect(visited).toEqual([...PLAYBACK_SPEEDS].reverse());
    });

    it('snaps to the nearest ladder step when current is off-ladder', () => {
        // 1.1 is closest to 1 -> stepping up should land at 1.25
        expect(nextSpeed(1.1, 1)).toBe(1.25);
        // 0.6 is closest to 0.5 -> stepping up should land at 0.75
        expect(nextSpeed(0.6, 1)).toBe(0.75);
    });

    it('direction === 0 returns the nearest ladder step (no movement)', () => {
        expect(nextSpeed(1, 0)).toBe(1);
        expect(nextSpeed(1.1, 0)).toBe(1);
    });

    it('falls back to the default when current is non-finite', () => {
        expect(nextSpeed(Number.NaN, 1)).toBe(DEFAULT_PLAYBACK_SPEED);
        expect(nextSpeed(Number.POSITIVE_INFINITY, -1)).toBe(DEFAULT_PLAYBACK_SPEED);
    });
});

describe('videoUtils — clampTime (±10s skip)', () => {
    it('clamps to 0 when the resulting time is negative', () => {
        // Skip backward from 5s by 10s -> -5 -> clamped to 0.
        expect(clampTime(5 - 10, 60)).toBe(0);
    });

    it('clamps to duration when the resulting time exceeds it', () => {
        // Skip forward from 55s by 10s -> 65 -> clamped to 60.
        expect(clampTime(55 + 10, 60)).toBe(60);
    });

    it('returns the input unchanged when within range', () => {
        expect(clampTime(15, 60)).toBe(15);
        expect(clampTime(0, 60)).toBe(0);
        expect(clampTime(60, 60)).toBe(60);
    });

    it('clamps NaN to 0', () => {
        expect(clampTime(Number.NaN, 60)).toBe(0);
    });

    it('without a known duration, only the lower bound is applied', () => {
        expect(clampTime(-5, Number.NaN)).toBe(0);
        expect(clampTime(123, Number.NaN)).toBe(123);
        expect(clampTime(123, 0)).toBe(123);
    });
});

describe('videoUtils — loopShouldRestart (A/B loop predicate)', () => {
    it('returns false when neither marker is set', () => {
        expect(loopShouldRestart(5, undefined, undefined)).toBe(false);
    });

    it('returns false when only A is set', () => {
        expect(loopShouldRestart(5, 2, undefined)).toBe(false);
    });

    it('returns false when only B is set (A missing)', () => {
        // Disambiguation: setting B before A is allowed, but looping is
        // refused until BOTH markers exist.
        expect(loopShouldRestart(5, undefined, 4)).toBe(false);
    });

    it('returns false when b <= a (nonsensical region)', () => {
        expect(loopShouldRestart(10, 5, 5)).toBe(false);
        expect(loopShouldRestart(10, 5, 3)).toBe(false);
    });

    it('returns false while playhead is inside [a, b)', () => {
        expect(loopShouldRestart(5, 4, 8)).toBe(false);
        expect(loopShouldRestart(4, 4, 8)).toBe(false);
        expect(loopShouldRestart(7.999, 4, 8)).toBe(false);
    });

    it('returns true when the playhead reaches B exactly', () => {
        expect(loopShouldRestart(8, 4, 8)).toBe(true);
    });

    it('returns true when the playhead has passed B', () => {
        expect(loopShouldRestart(9.5, 4, 8)).toBe(true);
    });

    it('handles non-finite inputs defensively', () => {
        expect(loopShouldRestart(Number.NaN, 4, 8)).toBe(false);
        expect(loopShouldRestart(5, Number.NaN, 8)).toBe(false);
        expect(loopShouldRestart(5, 4, Number.NaN)).toBe(false);
    });
});

describe('videoLoopRegion — set-then-clear sequence (DoD: A/B loop)', () => {
    // Walk the predicate through the user-visible sequence:
    //   1. neither set      -> no loop
    //   2. Set A only       -> no loop
    //   3. Set B before A   -> still no loop (b <= a)
    //   4. Set B after A    -> loop fires when crossing B
    //   5. Clear            -> no loop again
    it('only loops once both markers are set with b > a; clear disables', () => {
        let a: number | undefined;
        let b: number | undefined;

        expect(loopShouldRestart(5, a, b)).toBe(false);

        a = 4;
        expect(loopShouldRestart(5, a, b)).toBe(false);

        // User pressed Set B while playhead was still before A — should not
        // trigger a loop.
        b = 3;
        expect(loopShouldRestart(5, a, b)).toBe(false);

        // Now set B properly past A.
        b = 8;
        expect(loopShouldRestart(7, a, b)).toBe(false);
        expect(loopShouldRestart(8, a, b)).toBe(true);
        expect(loopShouldRestart(9, a, b)).toBe(true);

        // Clear A-B.
        a = undefined;
        b = undefined;
        expect(loopShouldRestart(9, a, b)).toBe(false);
    });
});
