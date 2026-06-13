// Unit tests for the audio viewer's pure formatting helpers (issue #24).
//
// These are the functions the file-info bar and timeline label callbacks
// rely on. Keeping them as thin pure helpers — and pinning the output here —
// means swapping the formatting logic later (for i18n, etc.) won't silently
// regress what the user sees.

import {
    formatTime,
    formatDurationCompact,
    formatSampleRate,
    formatBytes,
    detectFormatFromFileName
} from '../templates/audio/js/AudioController/utils/AudioUtils';

describe('formatTime', () => {
    it('zero pads seconds and milliseconds for monospace alignment', () => {
        expect(formatTime(0)).toBe('0:00.000');
        expect(formatTime(1)).toBe('0:01.000');
    });

    it('produces M:SS.mmm for sub-minute values', () => {
        // 5.123s -> "0:05.123"
        expect(formatTime(5.123)).toBe('0:05.123');
    });

    it('rolls minutes correctly past 60s', () => {
        // 1234s -> 20m 34s -> "20:34.000"
        expect(formatTime(1234)).toBe('20:34.000');
        // 75.456s -> 1m 15.456s
        expect(formatTime(75.456)).toBe('1:15.456');
    });

    it('clamps non-finite or negative values to zero', () => {
        expect(formatTime(Number.NaN)).toBe('0:00.000');
        expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00.000');
        expect(formatTime(-5)).toBe('0:00.000');
    });
});

describe('formatDurationCompact', () => {
    it('omits milliseconds and zero-pads seconds', () => {
        expect(formatDurationCompact(0)).toBe('0:00');
        expect(formatDurationCompact(75)).toBe('1:15');
        expect(formatDurationCompact(1234)).toBe('20:34');
    });

    it('floors fractional seconds', () => {
        expect(formatDurationCompact(75.999)).toBe('1:15');
    });

    it('returns a stable placeholder for non-finite inputs', () => {
        expect(formatDurationCompact(Number.NaN)).toBe('0:00');
    });
});

describe('formatSampleRate', () => {
    it('renders fractional kHz with one decimal', () => {
        expect(formatSampleRate(44100)).toBe('44.1 kHz');
    });

    it('renders whole-kHz rates without trailing .0', () => {
        expect(formatSampleRate(48000)).toBe('48 kHz');
        expect(formatSampleRate(96000)).toBe('96 kHz');
    });

    it('returns "--" for missing or non-positive values', () => {
        expect(formatSampleRate(0)).toBe('--');
        expect(formatSampleRate(null)).toBe('--');
        expect(formatSampleRate(undefined)).toBe('--');
        expect(formatSampleRate(Number.NaN)).toBe('--');
        expect(formatSampleRate(-1)).toBe('--');
    });
});

describe('formatBytes', () => {
    it('uses KB until the value crosses ~1 MB', () => {
        // VSCode original: when MB > 1, switch to MB; otherwise KB.
        expect(formatBytes(1024)).toBe('1 KB');
        expect(formatBytes(500 * 1024)).toBe('500 KB');
    });

    it('uses MB for values above 1 MB', () => {
        // 5 MB
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
        // 1.5 MB
        expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    });

    it('returns "--" for missing or invalid sizes', () => {
        expect(formatBytes(null)).toBe('--');
        expect(formatBytes(undefined)).toBe('--');
        expect(formatBytes(-100)).toBe('--');
    });
});

describe('detectFormatFromFileName', () => {
    it('uppercases the extension for unknown formats', () => {
        expect(detectFormatFromFileName('clip.opus')).toBe('OPUS');
    });

    it('maps common extensions to canonical labels', () => {
        expect(detectFormatFromFileName('song.mp3')).toBe('MP3');
        expect(detectFormatFromFileName('Song.Wav')).toBe('WAV');
        expect(detectFormatFromFileName('drum.FLAC')).toBe('FLAC');
        expect(detectFormatFromFileName('dialog.ogg')).toBe('OGG');
        expect(detectFormatFromFileName('voice.aac')).toBe('AAC');
        expect(detectFormatFromFileName('clip.webm')).toBe('WEBM');
        expect(detectFormatFromFileName('clip.m4a')).toBe('M4A');
    });

    it('returns "Unknown" when there is no extension', () => {
        expect(detectFormatFromFileName('audiofile')).toBe('Unknown');
        expect(detectFormatFromFileName('')).toBe('Unknown');
        expect(detectFormatFromFileName('no.dot.')).toBe('Unknown');
    });
});
