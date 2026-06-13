// Unit tests for `parseWavFmt` (issue #84) — extends the existing WAV
// header parser so the audio file-info chips for Sample Rate and Channels
// can show the source file's real metadata rather than the AudioContext's
// resample rate. The byte layout pinned here is the canonical PCM WAV
// `fmt ` chunk; if it drifts we'll silently start showing wrong values in
// the toolbar, so we lock it down with explicit cases.

import { parseWavFmt } from '../templates/audio/js/AudioController/utils/AudioUtils';

/**
 * Build a minimal canonical-PCM WAV header. Mirrors the helper in
 * audioMetaFormatters.test.ts but kept local so this file stays
 * self-contained (the original is only exported as a private helper).
 */
function makeWavHeader(opts: {
    bitsPerSample: number;
    numChannels?: number;
    sampleRate?: number;
    extraFmtBytes?: number;
}): ArrayBuffer {
    const numChannels = opts.numChannels ?? 2;
    const sampleRate = opts.sampleRate ?? 44100;
    const bitsPerSample = opts.bitsPerSample;
    const fmtPayloadSize = 16 + (opts.extraFmtBytes ?? 0);
    const dataSize = 0;
    const headerSize = 12 + 8 + fmtPayloadSize + 8 + dataSize;

    const buf = new ArrayBuffer(headerSize);
    const view = new DataView(buf);
    const writeAscii = (off: number, s: string): void => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, headerSize - 8, true);
    writeAscii(8, 'WAVE');

    writeAscii(12, 'fmt ');
    view.setUint32(16, fmtPayloadSize, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, numChannels * (bitsPerSample / 8), true);
    view.setUint16(34, bitsPerSample, true);

    const dataStart = 12 + 8 + fmtPayloadSize;
    writeAscii(dataStart, 'data');
    view.setUint32(dataStart + 4, dataSize, true);
    return buf;
}

describe('parseWavFmt', () => {
    it('extracts sampleRate / numChannels / bitsPerSample from a canonical header', () => {
        const buf = makeWavHeader({
            bitsPerSample: 16,
            numChannels: 2,
            sampleRate: 44100
        });
        expect(parseWavFmt(buf)).toEqual({
            bitsPerSample: 16,
            sampleRate: 44100,
            numChannels: 2
        });
    });

    it('parses non-44.1 kHz rates and mono / surround channel counts', () => {
        expect(parseWavFmt(makeWavHeader({ bitsPerSample: 24, numChannels: 1, sampleRate: 48000 }))).toEqual({
            bitsPerSample: 24,
            sampleRate: 48000,
            numChannels: 1
        });
        expect(parseWavFmt(makeWavHeader({ bitsPerSample: 16, numChannels: 6, sampleRate: 96000 }))).toEqual({
            bitsPerSample: 16,
            sampleRate: 96000,
            numChannels: 6
        });
    });

    it('handles fmt chunks larger than the canonical 16 bytes', () => {
        // WAVEFORMATEX / WAVEFORMATEXTENSIBLE pad the fmt chunk; the offsets
        // we read should still point at the right LE words.
        const buf = makeWavHeader({
            bitsPerSample: 24,
            numChannels: 2,
            sampleRate: 88200,
            extraFmtBytes: 8
        });
        expect(parseWavFmt(buf)).toEqual({
            bitsPerSample: 24,
            sampleRate: 88200,
            numChannels: 2
        });
    });

    it('returns null when RIFF/WAVE magic bytes are missing', () => {
        // All zeros => no RIFF magic.
        expect(parseWavFmt(new ArrayBuffer(64))).toBeNull();
    });

    it('returns null for null / undefined / short buffers', () => {
        expect(parseWavFmt(null)).toBeNull();
        expect(parseWavFmt(undefined)).toBeNull();
        expect(parseWavFmt(new ArrayBuffer(10))).toBeNull();
    });

    it('returns null when no fmt sub-chunk is present', () => {
        const buf = new ArrayBuffer(28);
        const view = new DataView(buf);
        const writeAscii = (off: number, s: string): void => {
            for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
        };
        writeAscii(0, 'RIFF');
        view.setUint32(4, 20, true);
        writeAscii(8, 'WAVE');
        writeAscii(12, 'JUNK');
        view.setUint32(16, 8, true);
        expect(parseWavFmt(buf)).toBeNull();
    });

    it('returns null when fmt fields are zero (corrupt header)', () => {
        // Build a header then zero out the sampleRate field so the helper
        // doesn't accidentally return a half-valid record.
        const buf = makeWavHeader({ bitsPerSample: 16 });
        const view = new DataView(buf);
        // fmt payload starts at offset 20; sampleRate is +4 inside payload = 24.
        view.setUint32(24, 0, true);
        expect(parseWavFmt(buf)).toBeNull();
    });
});
