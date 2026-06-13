// Unit tests for the audio decoder router (issue #26).
//
// The router decides whether a given filename can be decoded by:
//   - the browser-native <audio> path (WaveSurfer)             -> 'native'
//   - a (deferred) WASM decoder we haven't shipped yet          -> 'wasm-stub'
//   - nothing in this build                                     -> 'unsupported'
//
// These tests pin the routing decisions and the human-friendly error
// message so future PRs adjusting the manifest's audio extensions surface
// here as expected diffs.

import {
    decoderForExtension,
    formatNotSupportedMessage,
    AudioDecoderRouter
} from '../templates/audio/js/AudioController/utils/AudioDecoderRouter';

describe('decoderForExtension - native formats', () => {
    it('routes the previously-supported WaveSurfer extensions to native', () => {
        // Anything previously decoded by the audio viewer must keep working.
        expect(decoderForExtension('clip.wav')).toBe('native');
        expect(decoderForExtension('clip.mp3')).toBe('native');
        expect(decoderForExtension('clip.flac')).toBe('native');
        expect(decoderForExtension('clip.ogg')).toBe('native');
        expect(decoderForExtension('clip.m4a')).toBe('native');
    });

    it('routes additional browser-native audio extensions to native', () => {
        // These are accepted by the manifest and Chrome can decode them in
        // most builds. The native path tries first; the existing decode-
        // error UI handles any platform-specific failures.
        expect(decoderForExtension('voice.aac')).toBe('native');
        expect(decoderForExtension('clip.oga')).toBe('native');
        expect(decoderForExtension('clip.opus')).toBe('native');
        expect(decoderForExtension('clip.wma')).toBe('native');
        expect(decoderForExtension('clip.webm')).toBe('native');
    });

    it('routes AIFF and AC3 to native (best-effort)', () => {
        // Safari decodes AIFF natively; Chrome+platform-codecs sometimes
        // does AC3. The router routes them through native and lets the
        // decode-error path surface failures rather than blocking decode.
        expect(decoderForExtension('song.aiff')).toBe('native');
        expect(decoderForExtension('song.aif')).toBe('native');
        expect(decoderForExtension('song.aifc')).toBe('native');
        expect(decoderForExtension('clip.ac3')).toBe('native');
    });

    it('is case-insensitive on the extension', () => {
        expect(decoderForExtension('CLIP.MP3')).toBe('native');
        expect(decoderForExtension('Song.Wav')).toBe('native');
        expect(decoderForExtension('Voice.AIFF')).toBe('native');
    });

    it('handles paths with multiple dots correctly', () => {
        // The decision must use the last extension only.
        expect(decoderForExtension('archive.tar.mp3')).toBe('native');
        expect(decoderForExtension('my.song.v2.flac')).toBe('native');
    });
});

describe('decoderForExtension - wasm-stub formats (deferred)', () => {
    it('routes raw PCM, AMR, and AMR-WB to wasm-stub', () => {
        // These need a WASM decoder we haven't shipped yet. The router
        // returns 'wasm-stub' so callers can distinguish "deferred" from
        // "we don't know what this is at all".
        expect(decoderForExtension('raw.pcm')).toBe('wasm-stub');
        expect(decoderForExtension('voice.amr')).toBe('wasm-stub');
        expect(decoderForExtension('voice.awb')).toBe('wasm-stub');
    });

    it('treats wasm-stub formats case-insensitively', () => {
        expect(decoderForExtension('RAW.PCM')).toBe('wasm-stub');
        expect(decoderForExtension('Voice.Amr')).toBe('wasm-stub');
    });
});

describe('decoderForExtension - unsupported inputs', () => {
    it('returns unsupported for unknown extensions', () => {
        expect(decoderForExtension('clip.xyz')).toBe('unsupported');
        expect(decoderForExtension('document.pdf')).toBe('unsupported');
        expect(decoderForExtension('image.png')).toBe('unsupported');
    });

    it('returns unsupported when there is no extension', () => {
        expect(decoderForExtension('audiofile')).toBe('unsupported');
        expect(decoderForExtension('')).toBe('unsupported');
        // Trailing dot but no real extension.
        expect(decoderForExtension('weird.')).toBe('unsupported');
    });

    it('does not crash on null-ish-looking inputs', () => {
        // The signature is `string`, but in JS a caller could pass `''`
        // (already covered) or whitespace. Make sure we don't throw.
        expect(decoderForExtension('   ')).toBe('unsupported');
    });
});

describe('formatNotSupportedMessage', () => {
    it('includes the uppercased extension in the message', () => {
        expect(formatNotSupportedMessage('voice.amr')).toContain('AMR');
        expect(formatNotSupportedMessage('raw.pcm')).toContain('PCM');
        expect(formatNotSupportedMessage('voice.awb')).toContain('AWB');
    });

    it('uses a clear "not yet" phrasing for deferred formats', () => {
        const msg = formatNotSupportedMessage('voice.amr');
        // The exact wording can evolve; what we pin is that the message
        // tells the user the format isn't decodable yet, without leaking
        // implementation jargon.
        expect(msg.toLowerCase()).toContain("aren't decodable");
        expect(msg.toLowerCase()).toContain('build');
        // No implementation jargon.
        expect(msg.toLowerCase()).not.toContain('wasm');
        expect(msg.toLowerCase()).not.toContain('decoder');
    });

    it('falls back to a generic message when the file has no extension', () => {
        const msg = formatNotSupportedMessage('audiofile');
        expect(msg.length).toBeGreaterThan(0);
        // Should not contain a stray empty-uppercased extension.
        expect(msg).not.toMatch(/^\s+files/);
    });

    it('renders unknown extensions explicitly so the user sees what we got', () => {
        const msg = formatNotSupportedMessage('weird.xyz');
        expect(msg).toContain('XYZ');
    });
});

describe('AudioDecoderRouter aggregate', () => {
    it('exposes the same functions as the namespaced object', () => {
        expect(AudioDecoderRouter.decoderForExtension).toBe(decoderForExtension);
        expect(AudioDecoderRouter.formatNotSupportedMessage).toBe(
            formatNotSupportedMessage
        );
    });
});
