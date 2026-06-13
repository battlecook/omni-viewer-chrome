// Tests for the expanded archive preview classifier (issue #57).
//
// The classifier decides how the in-archive preview pane should render an
// extracted entry: as inline text, an image / audio / video blob, a hex
// dump fallback, or a "too large" download affordance. These cases extend
// the original `archivePreviewDecoder.test.ts` (which covers Android binary
// XML decoding) without overlapping with it.

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof NodeTextEncoder }).TextEncoder = NodeTextEncoder;
}
if (typeof (globalThis as { TextDecoder?: unknown }).TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof NodeTextDecoder }).TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;
}

import {
    ARCHIVE_HEX_PREVIEW_LIMIT,
    ARCHIVE_TEXT_PREVIEW_LIMIT,
    classifyArchivePreview,
} from '../utils/fileUtils/archivePreviewDecoder';

describe('classifyArchivePreview', () => {
    describe('text', () => {
        it('decodes a small UTF-8 text entry inline', () => {
            const bytes = new TextEncoder().encode('hello world\n');
            const result = classifyArchivePreview('readme.txt', bytes);

            expect(result.kind).toBe('text');
            expect(result.text).toBe('hello world\n');
            expect(result.byteLength).toBe(bytes.length);
            expect(result.mime).toBeUndefined();
        });

        it('treats an empty payload as zero-byte text', () => {
            const result = classifyArchivePreview('empty.txt', new Uint8Array(0));
            expect(result.kind).toBe('text');
            expect(result.text).toBe('');
            expect(result.byteLength).toBe(0);
        });

        it('flags overly large textual payloads as too-large', () => {
            // 1 byte over the cap ensures we cross the boundary even if the
            // implementation uses `>` vs `>=`.
            const big = new Uint8Array(ARCHIVE_TEXT_PREVIEW_LIMIT + 1);
            big.fill(0x61); // 'a'
            const result = classifyArchivePreview('big.log', big);

            expect(result.kind).toBe('too-large');
            expect(result.text).toBeUndefined();
            expect(result.byteLength).toBe(big.length);
        });
    });

    describe('images', () => {
        it('classifies PNG by its magic bytes even without an extension', () => {
            const png = new Uint8Array([
                0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
                ...new Array(32).fill(0x00),
            ]);
            const result = classifyArchivePreview('payload.bin', png);
            expect(result.kind).toBe('image');
            expect(result.mime).toBe('image/png');
        });

        it('classifies JPEG by extension when bytes are ambiguous', () => {
            const bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
            const result = classifyArchivePreview('icon.jpg', bytes);
            expect(result.kind).toBe('image');
            expect(result.mime).toBe('image/jpeg');
        });

        it('classifies GIF by extension', () => {
            const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00]);
            const result = classifyArchivePreview('frames.gif', bytes);
            expect(result.kind).toBe('image');
            expect(result.mime).toBe('image/gif');
        });

        it('classifies WebP by RIFF/WEBP signature', () => {
            const bytes = new Uint8Array([
                0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00,
                0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
            ]);
            const result = classifyArchivePreview('photo.bin', bytes);
            expect(result.kind).toBe('image');
            expect(result.mime).toBe('image/webp');
        });

        it('classifies SVG markup with a plain `<svg>` root', () => {
            const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
            const result = classifyArchivePreview('icon.svg', bytes);
            expect(result.kind).toBe('image');
            expect(result.mime).toBe('image/svg+xml');
        });
    });

    describe('audio', () => {
        it('classifies WAV by RIFF/WAVE signature', () => {
            const bytes = new Uint8Array([
                0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00,
                0x57, 0x41, 0x56, 0x45, 0x66, 0x6D, 0x74, 0x20,
            ]);
            const result = classifyArchivePreview('clip.wav', bytes);
            expect(result.kind).toBe('audio');
            expect(result.mime).toBe('audio/wav');
        });

        it('classifies MP3 by extension when bytes are ambiguous text-ish', () => {
            // Use ID3 magic so the magic-byte sniff lights up too.
            const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00]);
            const result = classifyArchivePreview('song.mp3', bytes);
            expect(result.kind).toBe('audio');
            expect(result.mime).toBe('audio/mpeg');
        });

        it('classifies FLAC by signature', () => {
            const bytes = new Uint8Array([0x66, 0x4C, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]);
            const result = classifyArchivePreview('clip.flac', bytes);
            expect(result.kind).toBe('audio');
            expect(result.mime).toBe('audio/flac');
        });
    });

    describe('video', () => {
        it('classifies WebM/Matroska by EBML signature', () => {
            const bytes = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81]);
            const result = classifyArchivePreview('clip.webm', bytes);
            expect(result.kind).toBe('video');
            expect(result.mime).toBe('video/webm');
        });

        it('classifies an MP4 by extension', () => {
            // ftyp box at offset 4: "ftypisom"
            const bytes = new Uint8Array([
                0x00, 0x00, 0x00, 0x20,
                0x66, 0x74, 0x79, 0x70,
                0x69, 0x73, 0x6F, 0x6D,
                0x00, 0x00, 0x02, 0x00,
            ]);
            const result = classifyArchivePreview('movie.mp4', bytes);
            expect(result.kind).toBe('video');
            expect(result.mime).toBe('video/mp4');
        });

        it('classifies .m4a as audio even though the ftyp magic also matches video', () => {
            const bytes = new Uint8Array([
                0x00, 0x00, 0x00, 0x20,
                0x66, 0x74, 0x79, 0x70,
                0x4D, 0x34, 0x41, 0x20,
                0x00, 0x00, 0x02, 0x00,
            ]);
            const result = classifyArchivePreview('song.m4a', bytes);
            expect(result.kind).toBe('audio');
            expect(result.mime).toBe('audio/mp4');
        });
    });

    describe('binary fallback', () => {
        it('produces a hex dump for opaque binary entries', () => {
            const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xFD]);
            const result = classifyArchivePreview('blob.dat', bytes);

            expect(result.kind).toBe('binary');
            expect(result.hex).toBeDefined();
            // First column is the offset; each row begins with an 8-digit hex.
            expect(result.hex).toMatch(/^00000000\s/);
            // The first byte 00 should appear in the hex column.
            expect(result.hex).toContain('00 01 02 03 ff fe fd');
        });

        it('truncates hex previews at the configured limit', () => {
            const bytes = new Uint8Array(ARCHIVE_HEX_PREVIEW_LIMIT + 64);
            // Sprinkle non-ASCII bytes so the heuristic firmly picks "binary".
            for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i % 250) + 1;
            // Inject a NUL near the start so `looksLikeText` rejects it.
            bytes[1] = 0x00;

            const result = classifyArchivePreview('blob.bin', bytes);
            expect(result.kind).toBe('binary');
            expect(result.hex).toContain(`... (${bytes.length - ARCHIVE_HEX_PREVIEW_LIMIT} more bytes)`);
        });
    });
});
