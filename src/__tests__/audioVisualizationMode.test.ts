// Unit tests for the audio viewer's visualization-mode helpers (issue #83).
//
// These pure helpers underpin the toolbar mode buttons (Waveform / Spectrogram
// / Both). The mapping they encode is mirrored by the CSS rules in
// audioViewer.css — pinning them here prevents the two from drifting and
// guards against the original bug where "Waveform" leaked the spectrogram
// and "Spectrogram" rendered an empty viewer.

import {
    normalizeVisualizationMode,
    visualizationModeLayers
} from '../templates/audio/js/AudioController';

describe('normalizeVisualizationMode', () => {
    it('passes through the three canonical modes verbatim', () => {
        expect(normalizeVisualizationMode('waveform')).toBe('waveform');
        expect(normalizeVisualizationMode('spectrogram')).toBe('spectrogram');
        expect(normalizeVisualizationMode('both')).toBe('both');
    });

    it('falls back to waveform for unknown / legacy / empty input', () => {
        expect(normalizeVisualizationMode('')).toBe('waveform');
        expect(normalizeVisualizationMode('wave')).toBe('waveform');
        expect(normalizeVisualizationMode('spec')).toBe('waveform');
        expect(normalizeVisualizationMode('Both')).toBe('waveform');
    });
});

describe('visualizationModeLayers', () => {
    it('shows only the waveform in "waveform" mode', () => {
        expect(visualizationModeLayers('waveform')).toEqual({
            showWaveform: true,
            showSpectrogram: false
        });
    });

    it('shows only the spectrogram in "spectrogram" mode', () => {
        expect(visualizationModeLayers('spectrogram')).toEqual({
            showWaveform: false,
            showSpectrogram: true
        });
    });

    it('shows both layers in "both" mode', () => {
        expect(visualizationModeLayers('both')).toEqual({
            showWaveform: true,
            showSpectrogram: true
        });
    });
});
