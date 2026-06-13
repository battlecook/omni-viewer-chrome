// Unit tests for `src/templates/video/js/videoUtils.ts` (issue #28).
//
// The DoD asks for: file-info panel showing duration / resolution / format /
// fileSize. The pure helpers behind those four fields live in `videoUtils.ts`
// and are covered here. The progress-bar fraction <-> time math is covered as
// well, because the seek path depends on those helpers and their bounds
// behavior is the most likely source of off-by-one bugs.

import {
    formatTime,
    formatFileSize,
    formatResolution,
    getVideoFormatFromFile,
    clampFraction,
    fractionToTime,
    timeToFraction
} from '../templates/video/js/videoUtils';

describe('videoUtils — formatTime', () => {
    it('formats 0 as 0:00', () => {
        expect(formatTime(0)).toBe('0:00');
    });

    it('pads seconds to 2 digits', () => {
        expect(formatTime(5)).toBe('0:05');
        expect(formatTime(9)).toBe('0:09');
    });

    it('formats minute boundaries', () => {
        expect(formatTime(60)).toBe('1:00');
        expect(formatTime(61)).toBe('1:01');
        expect(formatTime(125)).toBe('2:05');
    });

    it('switches to h:mm:ss for durations >= 1h (issue #30)', () => {
        // Issue #30 extended the original VSCode `m:ss`-only behavior so
        // long videos display a sensible hours segment. Below 3600s the
        // shape stays `m:ss`; at/above 3600s it becomes `h:mm:ss` with
        // zero-padded minute and second segments.
        expect(formatTime(3600)).toBe('1:00:00');
        expect(formatTime(3661)).toBe('1:01:01');
        expect(formatTime(3599)).toBe('59:59');
        expect(formatTime(7200)).toBe('2:00:00');
        expect(formatTime(7325)).toBe('2:02:05');
    });

    it('floors fractional seconds', () => {
        expect(formatTime(1.9)).toBe('0:01');
        expect(formatTime(59.99)).toBe('0:59');
    });

    it('returns 0:00 for invalid input', () => {
        expect(formatTime(Number.NaN)).toBe('0:00');
        expect(formatTime(-1)).toBe('0:00');
        expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    });
});

describe('videoUtils — formatFileSize', () => {
    it('formats bytes', () => {
        expect(formatFileSize(0)).toBe('0 B');
        expect(formatFileSize(512)).toBe('512 B');
    });

    it('formats KB / MB / GB / TB with one decimal', () => {
        expect(formatFileSize(1024)).toBe('1.0 KB');
        expect(formatFileSize(1536)).toBe('1.5 KB');
        expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
        expect(formatFileSize(1.4 * 1024 * 1024)).toBe('1.4 MB');
        expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
        expect(formatFileSize(1024 ** 4)).toBe('1.0 TB');
    });

    it('returns "--" for invalid input', () => {
        expect(formatFileSize(Number.NaN)).toBe('--');
        expect(formatFileSize(-1)).toBe('--');
        expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('--');
    });
});

describe('videoUtils — formatResolution', () => {
    it('joins width and height with the multiplication sign', () => {
        expect(formatResolution(1920, 1080)).toBe('1920×1080');
        expect(formatResolution(640, 480)).toBe('640×480');
    });

    it('rounds to whole pixels', () => {
        expect(formatResolution(1280.4, 720.6)).toBe('1280×721');
    });

    it('returns "--" for missing/invalid dimensions', () => {
        expect(formatResolution(0, 0)).toBe('--');
        expect(formatResolution(1920, 0)).toBe('--');
        expect(formatResolution(Number.NaN, 1080)).toBe('--');
        expect(formatResolution(-1, 1080)).toBe('--');
    });
});

describe('videoUtils — getVideoFormatFromFile', () => {
    it('uses the MIME subtype when present', () => {
        expect(getVideoFormatFromFile({ name: 'clip.mp4', type: 'video/mp4' })).toBe('MP4');
        expect(getVideoFormatFromFile({ name: 'clip.webm', type: 'video/webm' })).toBe('WEBM');
    });

    it('strips x- vendor prefixes', () => {
        expect(getVideoFormatFromFile({ name: 'old.mov', type: 'video/x-matroska' })).toBe('MATROSKA');
    });

    it('falls back to extension when MIME is missing', () => {
        expect(getVideoFormatFromFile({ name: 'clip.MOV', type: '' })).toBe('MOV');
        expect(getVideoFormatFromFile({ name: 'clip.m4v' })).toBe('M4V');
    });

    it('returns empty string when neither source is usable', () => {
        expect(getVideoFormatFromFile({ name: 'noext', type: '' })).toBe('');
        expect(getVideoFormatFromFile({ name: 'trailing.', type: '' })).toBe('');
    });
});

describe('videoUtils — fraction helpers', () => {
    it('clampFraction confines values to [0, 1]', () => {
        expect(clampFraction(-0.5)).toBe(0);
        expect(clampFraction(0)).toBe(0);
        expect(clampFraction(0.5)).toBe(0.5);
        expect(clampFraction(1)).toBe(1);
        expect(clampFraction(2)).toBe(1);
        expect(clampFraction(Number.NaN)).toBe(0);
    });

    it('fractionToTime maps 0..1 onto 0..duration', () => {
        expect(fractionToTime(0, 100)).toBe(0);
        expect(fractionToTime(0.5, 100)).toBe(50);
        expect(fractionToTime(1, 100)).toBe(100);
        // out-of-range inputs are clamped, not extrapolated.
        expect(fractionToTime(-1, 100)).toBe(0);
        expect(fractionToTime(2, 100)).toBe(100);
    });

    it('fractionToTime returns 0 when duration is non-finite or non-positive', () => {
        expect(fractionToTime(0.5, 0)).toBe(0);
        expect(fractionToTime(0.5, -1)).toBe(0);
        expect(fractionToTime(0.5, Number.NaN)).toBe(0);
        expect(fractionToTime(0.5, Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('timeToFraction maps 0..duration onto 0..1', () => {
        expect(timeToFraction(0, 100)).toBe(0);
        expect(timeToFraction(50, 100)).toBe(0.5);
        expect(timeToFraction(100, 100)).toBe(1);
    });

    it('timeToFraction clamps overshoot to 1', () => {
        expect(timeToFraction(150, 100)).toBe(1);
    });

    it('timeToFraction returns 0 for invalid duration or current time', () => {
        expect(timeToFraction(50, 0)).toBe(0);
        expect(timeToFraction(50, Number.NaN)).toBe(0);
        expect(timeToFraction(Number.NaN, 100)).toBe(0);
        expect(timeToFraction(-5, 100)).toBe(0);
    });
});
