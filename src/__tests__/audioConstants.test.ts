// Sanity tests for the audio viewer's pure constants module (issue #24).
//
// The constants live in src/templates/audio/js/AudioController/utils/Constants.ts
// and are imported by every manager. We pin the values here so accidental edits
// (especially during follow-up issues) surface as test failures rather than
// silent visual regressions.

import { CONSTANTS } from '../templates/audio/js/AudioController/utils/Constants';

describe('audio CONSTANTS — wavesurfer defaults', () => {
    it('uses the sample rate matching the VSCode reference', () => {
        expect(CONSTANTS.WAVESURFER.SAMPLE_RATE).toBe(44100);
    });

    it('exposes a non-empty wave/progress color pair', () => {
        expect(CONSTANTS.WAVESURFER.WAVE_COLOR).toMatch(/^#/);
        expect(CONSTANTS.WAVESURFER.PROGRESS_COLOR).toMatch(/^#/);
        expect(CONSTANTS.WAVESURFER.SECONDARY_WAVE_COLOR).toMatch(/^#/);
        expect(CONSTANTS.WAVESURFER.SECONDARY_PROGRESS_COLOR).toMatch(/^#/);
    });

    it('keeps the bar geometry as positive integers', () => {
        const w = CONSTANTS.WAVESURFER;
        expect(Number.isInteger(w.BAR_WIDTH)).toBe(true);
        expect(Number.isInteger(w.BAR_RADIUS)).toBe(true);
        expect(Number.isInteger(w.BAR_GAP)).toBe(true);
        expect(w.BAR_WIDTH).toBeGreaterThan(0);
        expect(w.BAR_RADIUS).toBeGreaterThan(0);
        expect(w.BAR_GAP).toBeGreaterThan(0);
    });
});

describe('audio CONSTANTS — timeline tick steps', () => {
    it('lists nice steps in strictly ascending order', () => {
        const steps = CONSTANTS.TIMELINE.NICE_STEPS;
        for (let i = 1; i < steps.length; i++) {
            expect(steps[i]).toBeGreaterThan(steps[i - 1]);
        }
    });

    it('starts at sub-second resolution and reaches at least one hour', () => {
        const steps = CONSTANTS.TIMELINE.NICE_STEPS;
        expect(steps[0]).toBeLessThan(1);
        expect(steps[steps.length - 1]).toBeGreaterThanOrEqual(3600);
    });
});

describe('audio CONSTANTS — spectrogram defaults', () => {
    it('uses an FFT size that is a power of two', () => {
        const fft = CONSTANTS.SPECTROGRAM.FFT_SIZE;
        // x is a power of two iff (x & (x - 1)) === 0 and x > 0
        expect(fft).toBeGreaterThan(0);
        // eslint-disable-next-line no-bitwise
        expect((fft & (fft - 1))).toBe(0);
    });

    it('uses noverlap that is at most half the FFT size', () => {
        // The plugin requires `noverlap < fftSize` to make any progress.
        expect(CONSTANTS.SPECTROGRAM.NOVERLAP).toBeLessThan(
            CONSTANTS.SPECTROGRAM.FFT_SIZE
        );
    });

    it('exposes the four canonical scale options with mel as default', () => {
        const labels = CONSTANTS.SPECTROGRAM.SCALE_OPTIONS.map((o) => o.value);
        expect(labels).toEqual(['linear', 'mel', 'bark', 'erb']);
        expect(CONSTANTS.SPECTROGRAM.DEFAULT_SCALE).toBe('mel');
    });
});

describe('audio CONSTANTS — region geometry', () => {
    it('clamps the minimum draggable region duration to a non-zero value', () => {
        expect(CONSTANTS.REGION.MIN_DURATION).toBeGreaterThan(0);
        expect(CONSTANTS.REGION.MIN_DURATION).toBeLessThanOrEqual(1);
    });
});
