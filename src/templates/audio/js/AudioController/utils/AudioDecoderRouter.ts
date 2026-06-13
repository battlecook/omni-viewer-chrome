// Pure decoder routing for the audio viewer (issue #26).
//
// The Chrome manifest accepts a wider set of audio extensions than the
// current build can actually decode. Most well-known formats (WAV, MP3,
// FLAC, OGG, AAC, M4A, WEBM, etc.) are decoded directly by the browser via
// the WaveSurfer + <audio> path. A handful of newer formats accepted by the
// manifest (raw PCM, AMR, AMR-WB) require a WASM decoder which is not part
// of this slice — that work is tracked as a follow-up to #26.
//
// This module exposes two pure helpers:
//
//   - `decoderForExtension(filename)` returns one of:
//       * 'native'      — decode via the browser-native WaveSurfer path
//       * 'wasm-stub'   — would decode via WASM, but the WASM glue isn't
//                         shipped in this build yet (treated as unsupported
//                         at runtime, but kept distinct so callers can
//                         emit a more helpful message later)
//       * 'unsupported' — extension is not recognized as audio
//   - `formatNotSupportedMessage(filename)` returns a user-friendly string
//     to render when the viewer is asked to load a file it can't decode.
//
// Both helpers are pure (no DOM, no globals) so they are easy to test and
// can be safely imported from any layer of the audio viewer.
//
// TODO(audio-wasm-decoders, follow-up to #26): once the WASM build pipeline
// lands (`src/wasm/audio_engine.c` rebuild + `vendor/audio_engine_browser.js`
// regeneration), promote the 'wasm-stub' formats below to real decoders and
// update `decoderForExtension` to return 'wasm' (or similar) for them.

export type AudioDecoderKind = 'native' | 'wasm-stub' | 'unsupported';

/**
 * Extensions that the browser can decode directly (via WaveSurfer's <audio>
 * element source). Stored as a Set for O(1) lookups.
 *
 * Note: `aac`, `oga`, `wma`, `opus` aren't all guaranteed to decode in every
 * Chrome build — Chrome ships an Opus decoder out of the box, AAC depends on
 * platform codecs, and WMA is essentially unsupported on Chromium. We still
 * route them down the native path because that's the best-effort behavior:
 * the browser will throw a decode error if it can't handle the bytes, and
 * the existing error UI in `index.ts` already surfaces that to the user.
 */
const NATIVE_EXTENSIONS: ReadonlySet<string> = new Set([
    'wav',
    'mp3',
    'flac',
    'ogg',
    'oga',
    'aac',
    'm4a',
    'opus',
    'wma',
    'webm'
]);

/**
 * Extensions that the manifest accepts but require a WASM decoder we have
 * not yet shipped. Today these route to 'wasm-stub', which the audio
 * viewer treats as unsupported (showing a friendly "not yet" panel).
 *
 * AIFF (`aiff`/`aif`/`aifc`) is NOT in this set: Safari can decode it
 * natively, and Chrome can in some builds, so we route it through the
 * native path and rely on the existing decode-error UI when that fails.
 *
 * AC3 is similarly best-effort native: some Chrome builds have AC3 codec
 * support (especially Chrome on Windows / macOS with platform codecs), so
 * we let the native path try first.
 */
const WASM_STUB_EXTENSIONS: ReadonlySet<string> = new Set([
    'pcm',
    'amr',
    'awb'
]);

/**
 * Best-effort native extensions — the manifest accepts them, the browser
 * may or may not decode them depending on the build/platform. We still
 * treat them as 'native' so we don't regress users on platforms where the
 * codec is available; if decoding fails, the existing audio-error path
 * handles it.
 */
const BEST_EFFORT_NATIVE_EXTENSIONS: ReadonlySet<string> = new Set([
    'aiff',
    'aif',
    'aifc',
    'ac3'
]);

/**
 * Lowercase a filename and return its extension without the leading dot.
 * Returns '' when no extension is present.
 */
function extractExtension(filename: string): string {
    const safe = (filename || '').toLowerCase();
    const dot = safe.lastIndexOf('.');
    if (dot < 0 || dot === safe.length - 1) {
        return '';
    }
    return safe.slice(dot + 1);
}

/**
 * Decide which decoder path a given filename should take.
 *
 * Examples:
 *   decoderForExtension('clip.mp3')   -> 'native'
 *   decoderForExtension('voice.amr')  -> 'wasm-stub'
 *   decoderForExtension('raw.pcm')    -> 'wasm-stub'
 *   decoderForExtension('clip.aiff')  -> 'native'
 *   decoderForExtension('weird.xyz')  -> 'unsupported'
 *   decoderForExtension('noext')      -> 'unsupported'
 */
export function decoderForExtension(filename: string): AudioDecoderKind {
    const ext = extractExtension(filename);
    if (!ext) {
        return 'unsupported';
    }
    if (NATIVE_EXTENSIONS.has(ext) || BEST_EFFORT_NATIVE_EXTENSIONS.has(ext)) {
        return 'native';
    }
    if (WASM_STUB_EXTENSIONS.has(ext)) {
        return 'wasm-stub';
    }
    return 'unsupported';
}

/**
 * Build a user-friendly "format not supported" message for a filename.
 *
 * The message intentionally avoids implementation jargon ("WASM",
 * "decoder", etc.) and tells the user what file we got and that it isn't
 * playable in the current build. The caller is responsible for rendering
 * the string into the viewer's error panel.
 */
export function formatNotSupportedMessage(filename: string): string {
    const ext = extractExtension(filename);
    if (!ext) {
        return "This file doesn't have an audio extension we recognize yet.";
    }
    const upper = ext.toUpperCase();
    return `${upper} files aren't decodable in this build yet.`;
}

// Aggregate object so call sites that prefer namespaced access can use it
// without changing imports. Mirrors the shape of `AudioUtils`.
export const AudioDecoderRouter = {
    decoderForExtension,
    formatNotSupportedMessage
};
