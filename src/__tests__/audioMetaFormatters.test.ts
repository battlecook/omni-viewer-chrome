// Unit tests for the bit-depth + channel-layout helpers added in issue #25.
//
// Pure helpers — no DOM, no WaveSurfer dependency. The header parsers receive
// hand-built ArrayBuffers so the tests pin the byte-level wire format that
// the helpers expect. This is intentional: the parsers are the only path
// through which 16/24/32-bit WAV bit depth reaches the file-info bar, so a
// regression here would silently break the issue's DoD.

import {
    formatChannelLayout,
    parseFlacBitDepth,
    parseWavBitDepth
} from '../templates/audio/js/AudioController/utils/AudioUtils';

/**
 * Build a minimal canonical-PCM WAV header so we can exercise the parser
 * without pulling in a binary fixture. Only the bytes the parser reads need
 * to be accurate; the data chunk is empty.
 */
function makeWavHeader(opts: {
    bitsPerSample: number;
    numChannels?: number;
    sampleRate?: number;
    extraFmtBytes?: number; // pad fmt chunk so we cover non-16-byte fmt sizes
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

    // RIFF / WAVE.
    writeAscii(0, 'RIFF');
    view.setUint32(4, headerSize - 8, true);
    writeAscii(8, 'WAVE');

    // fmt sub-chunk.
    writeAscii(12, 'fmt ');
    view.setUint32(16, fmtPayloadSize, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, numChannels * (bitsPerSample / 8), true);
    view.setUint16(34, bitsPerSample, true);
    // Any extra fmt bytes (e.g. WAVEFORMATEXTENSIBLE) stay zero — fine for the parser.

    // data sub-chunk header (no payload).
    const dataStart = 12 + 8 + fmtPayloadSize;
    writeAscii(dataStart, 'data');
    view.setUint32(dataStart + 4, dataSize, true);
    return buf;
}

describe('formatChannelLayout', () => {
    it.each([
        [1, 'Mono'],
        [2, 'Stereo'],
        [6, '5.1 Surround'],
        [8, '7.1 Surround']
    ])('maps %d channels to %s', (channels, label) => {
        expect(formatChannelLayout(channels)).toBe(label);
    });

    it('falls back to "Nch" for non-canonical channel counts', () => {
        expect(formatChannelLayout(3)).toBe('3ch');
        expect(formatChannelLayout(4)).toBe('4ch');
        expect(formatChannelLayout(5)).toBe('5ch');
        expect(formatChannelLayout(7)).toBe('7ch');
        expect(formatChannelLayout(10)).toBe('10ch');
    });

    it('returns "--" for missing or non-positive inputs', () => {
        expect(formatChannelLayout(0)).toBe('--');
        expect(formatChannelLayout(-1)).toBe('--');
        expect(formatChannelLayout(null)).toBe('--');
        expect(formatChannelLayout(undefined)).toBe('--');
        expect(formatChannelLayout(Number.NaN)).toBe('--');
    });

    it('rounds fractional channel counts before mapping', () => {
        // Defensive — AudioBuffer.numberOfChannels is always integer, but the
        // helper is reachable from metadata.channels which has wider typing.
        expect(formatChannelLayout(2.0)).toBe('Stereo');
        expect(formatChannelLayout(1.4)).toBe('Mono');
        expect(formatChannelLayout(1.6)).toBe('Stereo');
    });
});

describe('parseWavBitDepth', () => {
    it.each([16, 24, 32])('extracts %d-bit depth from a canonical PCM WAV header', (bits) => {
        const buf = makeWavHeader({ bitsPerSample: bits });
        expect(parseWavBitDepth(buf)).toBe(bits);
    });

    it('handles fmt chunks larger than the canonical 16 bytes', () => {
        // WAVEFORMATEX / WAVEFORMATEXTENSIBLE pad the fmt chunk; the parser
        // must still find wBitsPerSample at the right payload offset.
        const buf = makeWavHeader({ bitsPerSample: 24, extraFmtBytes: 8 });
        expect(parseWavBitDepth(buf)).toBe(24);
    });

    it('returns null when RIFF/WAVE magic bytes are missing', () => {
        const buf = new ArrayBuffer(64);
        // All zeros => no RIFF magic.
        expect(parseWavBitDepth(buf)).toBeNull();
    });

    it('returns null for null/undefined/short buffers', () => {
        expect(parseWavBitDepth(null)).toBeNull();
        expect(parseWavBitDepth(undefined)).toBeNull();
        expect(parseWavBitDepth(new ArrayBuffer(10))).toBeNull();
    });

    it('returns null when no fmt sub-chunk is present', () => {
        // RIFF + WAVE magic, then a non-fmt sub-chunk only.
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
        // 8 zero bytes of payload for JUNK; no fmt chunk anywhere.
        expect(parseWavBitDepth(buf)).toBeNull();
    });
});

describe('parseFlacBitDepth (stub)', () => {
    it('returns null until a real bitstream parser is wired in', () => {
        // Stub — see TODO(audio-flac-bit-depth) in AudioUtils.
        const fakeFlac = new ArrayBuffer(1024);
        expect(parseFlacBitDepth(fakeFlac)).toBeNull();
        expect(parseFlacBitDepth(null)).toBeNull();
        expect(parseFlacBitDepth(undefined)).toBeNull();
    });
});
