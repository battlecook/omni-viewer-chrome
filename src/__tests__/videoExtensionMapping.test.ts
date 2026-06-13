// Issue #32 — verifies that the additional video container extensions
// (`.mts`/`.m2ts`/`.avi`/`.wmv`/`.flv`/`.mkv`, plus the previously-supported
// `.mp4`/`.webm`/`.mov`/`.m4v`/`.ogv`) all route to the video viewer, and
// that the unsupported-codec fallback panel renders the friendly message
// + a working Download anchor when the underlying `<video>` raises `error`.
//
// Runs under jest-environment-jsdom@29 (project default). jsdom does not
// expose TextEncoder / TextDecoder as globals at module-load time, so we
// polyfill them before importing the modules under test.

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof NodeTextEncoder }).TextEncoder = NodeTextEncoder;
}
if (typeof (globalThis as { TextDecoder?: unknown }).TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof NodeTextDecoder }).TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;
}

// jsdom@29 does not always expose `URL.createObjectURL`/`revokeObjectURL`.
// `mountVideoViewer` calls them when binding the <video> src, so we install
// a deterministic stub before importing the orchestration layer.
type CreateObjectURLFn = (obj: Blob | MediaSource) => string;
type RevokeObjectURLFn = (url: string) => void;
const URLLike = (globalThis as unknown as { URL: typeof URL }).URL;
if (URLLike) {
    let _counter = 0;
    if (typeof (URLLike as unknown as { createObjectURL?: CreateObjectURLFn }).createObjectURL !== 'function') {
        (URLLike as unknown as { createObjectURL: CreateObjectURLFn }).createObjectURL = () => {
            _counter += 1;
            return `blob:test/${_counter}`;
        };
    }
    if (typeof (URLLike as unknown as { revokeObjectURL?: RevokeObjectURLFn }).revokeObjectURL !== 'function') {
        (URLLike as unknown as { revokeObjectURL: RevokeObjectURLFn }).revokeObjectURL = () => {
            /* noop */
        };
    }
}

import { FileUtils } from '../utils/fileUtils';
import {
    buildUnsupportedCodecMessage,
    extOfFileName
} from '../templates/video/js/videoUtils';
import { mountVideoViewer } from '../templates/video/js/videoViewerMain';

function makeFile(bytes: Uint8Array | number[], name: string): File {
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new File([payload], name);
}

function asciiBytes(value: string): Uint8Array {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
        out[i] = value.charCodeAt(i) & 0xff;
    }
    return out;
}

function concatBytes(...parts: Array<Uint8Array | number[]>): Uint8Array {
    const arrays = parts.map((part) => (part instanceof Uint8Array ? part : new Uint8Array(part)));
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const arr of arrays) {
        out.set(arr, off);
        off += arr.length;
    }
    return out;
}

// --- Routing -------------------------------------------------------------

describe('FileUtils.detectViewerType — issue #32 video extensions', () => {
    it.each([
        '.mts',
        '.m2ts',
        '.avi',
        '.wmv',
        '.flv',
        '.mkv',
        '.m4v',
        '.ogv'
    ])('routes %s files via the extension fallback when the bytes are nondescript', async (ext) => {
        // Generic 64-byte payload that doesn't match any of the byte
        // signatures the detector recognises (no MP4 ftyp box, no RIFF/AVI
        // tag, no TS sync, no EBML, no FLV "FLV\x01", no ASF GUID).
        const bytes = new Uint8Array(64);
        const file = makeFile(bytes, `clip${ext}`);
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.videoViewer');
        // Extension fallback: not matched by signature.
        expect(result.matchedBySignature).toBe(false);
        expect(result.reason).toContain('extension fallback');
    });

    it('routes .avi by RIFF/AVI signature when present', async () => {
        const file = makeFile(
            concatBytes(asciiBytes('RIFF'), [0, 0, 0, 0], asciiBytes('AVI ')),
            'movie.avi'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.videoViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('AVI');
    });

    it('routes .mts by MPEG transport stream sync packets', async () => {
        // Three packets of 188 bytes, each starting with the 0x47 sync byte.
        const packet = new Uint8Array(188);
        packet[0] = 0x47;
        const file = makeFile(concatBytes(packet, packet, packet), 'broadcast.mts');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.videoViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('MPEG');
    });

    it('routes .m2ts by MPEG transport stream sync packets', async () => {
        const packet = new Uint8Array(188);
        packet[0] = 0x47;
        const file = makeFile(concatBytes(packet, packet, packet), 'bluray.m2ts');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.videoViewer');
        expect(result.matchedBySignature).toBe(true);
    });

    it('routes .mkv by EBML signature when the matroska header is intact', async () => {
        // EBML magic: 1A 45 DF A3.
        const file = makeFile([0x1A, 0x45, 0xDF, 0xA3, 0x00, 0x00, 0x00, 0x00], 'movie.mkv');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.videoViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toMatch(/EBML|Matroska/);
    });

    it('routes .flv by the FLV container signature', async () => {
        // FLV header: "FLV\x01" + flags byte + 4-byte data offset (=9).
        const file = makeFile(
            concatBytes(asciiBytes('FLV'), [0x01, 0x05, 0x00, 0x00, 0x00, 0x09]),
            'stream.flv'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.videoViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('FLV');
    });

    it('routes .wmv by the ASF/WMV header GUID', async () => {
        const guid = [
            0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11,
            0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C
        ];
        const file = makeFile(concatBytes(guid, [0, 0, 0, 0]), 'clip.wmv');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.videoViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toMatch(/ASF|WMV/);
    });
});

describe('FileUtils.getVideoMimeType — issue #32 extension MIME mapping', () => {
    it.each([
        ['clip.mts', 'video/mp2t'],
        ['clip.m2ts', 'video/mp2t'],
        ['clip.avi', 'video/x-msvideo'],
        ['clip.wmv', 'video/x-ms-wmv'],
        ['clip.flv', 'video/x-flv'],
        ['clip.mkv', 'video/x-matroska'],
        ['clip.m4v', 'video/x-m4v'],
        ['clip.ogv', 'video/ogg']
    ])('maps %s -> %s', (name, expected) => {
        expect(FileUtils.getVideoMimeType(name)).toBe(expected);
    });
});

// --- Fallback message helpers -------------------------------------------

describe('buildUnsupportedCodecMessage', () => {
    it('uses the upper-cased extension for the {ext} segment', () => {
        // Per issue #32 wording: "{ext} files use a codec your browser
        // doesn't decode natively. You can download the file or open it in
        // a media player." We render the bare extension name (no leading
        // dot, upper-cased) for readability.
        expect(buildUnsupportedCodecMessage('clip.wmv'))
            .toBe(
                "WMV files use a codec your browser doesn't decode natively. " +
                'You can download the file or open it in a media player.'
            );
        expect(buildUnsupportedCodecMessage('movie.AVI'))
            .toContain('AVI files use');
        expect(buildUnsupportedCodecMessage('broadcast.m2ts'))
            .toContain('M2TS files use');
    });

    it('falls back to a generic phrasing when the file has no extension', () => {
        const message = buildUnsupportedCodecMessage('noextension');
        expect(message).toContain('This video uses');
        expect(message).toContain('download the file');
    });
});

describe('extOfFileName', () => {
    it('returns the trailing ".ext" segment with the dot', () => {
        expect(extOfFileName('clip.mp4')).toBe('.mp4');
        expect(extOfFileName('Some.Long.Name.MKV')).toBe('.MKV');
    });

    it('returns the empty string when there is no extension', () => {
        expect(extOfFileName('noextension')).toBe('');
        expect(extOfFileName('trailing.')).toBe('');
    });
});

// --- Fallback panel state machine ---------------------------------------
//
// We mount the viewer into a detached <div>, fire the `<video>` `error`
// event, and assert that the unsupported-codec panel is shown with the
// expected message and a properly-configured Download anchor. We also
// assert the loader / wrapper are hidden afterwards so the user only
// sees the fallback.

describe('mountVideoViewer — #32 unsupported-codec fallback panel', () => {
    function mountInto(container: HTMLElement, file: File): { dispose(): void } {
        return mountVideoViewer(file, container);
    }

    it('shows the friendly panel + Download button when <video> fires error', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const file = new File([new Uint8Array(8)], 'clip.wmv', { type: 'video/x-ms-wmv' });
        const handle = mountInto(container, file);
        try {
            const video = container.querySelector<HTMLVideoElement>('#vv-video');
            const errorPanel = container.querySelector<HTMLElement>('#vv-error');
            const errorMessage = container.querySelector<HTMLElement>('#vv-errorMessage');
            const downloadAnchor = container.querySelector<HTMLAnchorElement>('#vv-errorDownload');
            const wrapper = container.querySelector<HTMLElement>('#vv-videoWrapper');
            const loading = container.querySelector<HTMLElement>('#vv-loading');

            expect(video).not.toBeNull();
            expect(errorPanel).not.toBeNull();
            expect(errorMessage).not.toBeNull();
            expect(downloadAnchor).not.toBeNull();

            // Initial state: error panel hidden, wrapper hidden (until
            // metadata loads), loader visible.
            expect(errorPanel!.style.display).toBe('none');

            // Simulate Chrome's "I can't decode this codec" event.
            video!.dispatchEvent(new Event('error'));

            // After: error panel shown, loader/wrapper hidden, message +
            // download anchor populated.
            expect(errorPanel!.style.display).toBe('flex');
            expect(loading!.style.display).toBe('none');
            expect(wrapper!.style.display).toBe('none');
            expect(errorMessage!.textContent).toContain('WMV files use');
            expect(errorMessage!.textContent).toContain('download the file');
            // The download href must be the blob URL that was assigned
            // to <video src> (mountVideoViewer creates one URL and reuses
            // it for both). The `download` attribute must contain the
            // original file name so the user gets the right name back.
            expect(downloadAnchor!.getAttribute('download')).toBe('clip.wmv');
            expect(downloadAnchor!.getAttribute('href')).toBe(video!.getAttribute('src'));
            expect(downloadAnchor!.getAttribute('href')).toMatch(/^blob:/);
        } finally {
            handle.dispose();
            container.remove();
        }
    });

    it('renders extension-specific copy for each of the #32 containers', () => {
        // Spot-check three of the six new extensions through the full
        // mount path. We don't loop through all of them because the per-
        // extension copy is already covered by the pure-helper test
        // above; this only verifies the wiring.
        const cases: Array<[string, string]> = [
            ['clip.mts', 'MTS files use'],
            ['clip.flv', 'FLV files use'],
            ['clip.mkv', 'MKV files use']
        ];
        for (const [name, fragment] of cases) {
            const container = document.createElement('div');
            document.body.appendChild(container);
            const handle = mountVideoViewer(new File([new Uint8Array(4)], name), container);
            try {
                const video = container.querySelector<HTMLVideoElement>('#vv-video')!;
                video.dispatchEvent(new Event('error'));
                const message = container.querySelector<HTMLElement>('#vv-errorMessage')!;
                expect(message.textContent).toContain(fragment);
            } finally {
                handle.dispose();
                container.remove();
            }
        }
    });
});
