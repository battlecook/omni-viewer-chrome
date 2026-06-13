// Issue #56 — TAR / GZ / TGZ / TBZ2 / TXZ + 7Z / RAR routing.
//
// Verifies, for every archive container the viewer claims to handle:
//
//   1. `detectArchiveFormatByMagic` recognises the signature (TAR's USTAR
//      magic at offset 257 is included alongside the leading-byte sniffs for
//      GZ / BZ2 / XZ / 7Z / RAR / ZIP).
//   2. `FileUtils.detectViewerType` routes the file to the archive viewer.
//   3. `formatArchiveLabel` returns a recognisable, user-facing label for
//      the header pill.
//   4. Extension fallback still works when the byte signature is missing.
//   5. Signature mismatches fall through to extension fallback (e.g. a
//      `photo.jpg` with TAR-shaped content does NOT route to the archive
//      viewer because JPEG signature wins, while a generic
//      "looks-like-nothing" payload with a `.tar` extension still lands in
//      the archive viewer).

// jest-environment-jsdom@29 does not expose TextEncoder/TextDecoder as
// globals. Polyfill from node:util before importing the module under test
// so its lazy decoders pick them up.
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof NodeTextEncoder }).TextEncoder = NodeTextEncoder;
}
if (typeof (globalThis as { TextDecoder?: unknown }).TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof NodeTextDecoder }).TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;
}

import {
    ArchiveFormat,
    detectArchiveFormat,
    detectArchiveFormatByExtension,
    detectArchiveFormatByMagic,
    formatArchiveLabel
} from '../utils/fileUtils/archive';
import { FileUtils } from '../utils/fileUtils';

function makeFile(bytes: Uint8Array | number[], name: string): File {
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new File([payload], name);
}

/**
 * Build a fake 512-byte TAR header block whose name field is the supplied
 * file name and whose USTAR magic ("ustar\x00") sits at offset 257 — the
 * single feature `detectArchiveFormatByMagic` relies on for TAR detection.
 */
function buildUstarHeader(name = 'hello.txt'): Uint8Array {
    const block = new Uint8Array(512);
    // name (offset 0, 100 bytes, NUL-terminated ASCII)
    for (let i = 0; i < name.length && i < 100; i++) {
        block[i] = name.charCodeAt(i);
    }
    // USTAR magic at offset 257: "ustar" + NUL
    const magic = [0x75, 0x73, 0x74, 0x61, 0x72, 0x00];
    for (let i = 0; i < magic.length; i++) {
        block[257 + i] = magic[i];
    }
    // version "00" at offset 263 (POSIX ustar). Not strictly required by the
    // sniff, but mirrors a realistic tar layout.
    block[263] = 0x30;
    block[264] = 0x30;
    return block;
}

const SIGNATURES: Array<{
    name: string;
    fileName: string;
    bytes: Uint8Array;
    format: ArchiveFormat;
    label: string;
}> = [
    {
        name: 'TAR (USTAR magic at offset 257)',
        fileName: 'archive.tar',
        bytes: buildUstarHeader(),
        format: 'tar',
        label: 'TAR'
    },
    {
        name: 'GZ (1F 8B)',
        fileName: 'payload.gz',
        bytes: new Uint8Array([0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]),
        format: 'gz',
        label: 'GZ'
    },
    {
        name: 'BZ2 (BZh)',
        fileName: 'payload.bz2',
        bytes: new Uint8Array([0x42, 0x5A, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26]),
        format: 'bz2',
        label: 'BZ2'
    },
    {
        name: 'XZ (FD 37 7A 58 5A 00)',
        fileName: 'payload.xz',
        bytes: new Uint8Array([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00, 0x00, 0x04]),
        format: 'xz',
        label: 'XZ'
    },
    {
        name: '7Z (37 7A BC AF 27 1C)',
        fileName: 'archive.7z',
        bytes: new Uint8Array([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0x00, 0x04]),
        format: 'sevenZip',
        label: '7Z'
    },
    {
        name: 'RAR v4 (Rar! 1A 07 00)',
        fileName: 'archive.rar',
        bytes: new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00]),
        format: 'rar',
        label: 'RAR'
    },
    {
        name: 'RAR v5 (Rar! 1A 07 01 00)',
        fileName: 'archive-v5.rar',
        bytes: new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00]),
        format: 'rar',
        label: 'RAR'
    }
];

describe('detectArchiveFormatByMagic — issue #56 signatures', () => {
    it.each(SIGNATURES)('recognises $name', ({ bytes, format }) => {
        expect(detectArchiveFormatByMagic(bytes)).toBe(format);
    });

    it('returns null for buffers shorter than 262 bytes that look TAR-ish', () => {
        // 5 bytes of "ustar" alone, with no offset 257 alignment, is NOT a
        // TAR header — the sniff must require the magic at offset 257.
        const bytes = new TextEncoder().encode('ustar');
        expect(detectArchiveFormatByMagic(bytes)).toBeNull();
    });

    it('rejects an otherwise-blank 512-byte block (no USTAR magic)', () => {
        const bytes = new Uint8Array(512);
        expect(detectArchiveFormatByMagic(bytes)).toBeNull();
    });

    it('does not confuse a leading-bytes "ustar" with a TAR archive', () => {
        // "ustar" placed at offset 0 (where it never appears in real TARs) —
        // the sniff anchors on offset 257, not the leading bytes.
        const block = new Uint8Array(512);
        const leading = [0x75, 0x73, 0x74, 0x61, 0x72];
        for (let i = 0; i < leading.length; i++) block[i] = leading[i];
        expect(detectArchiveFormatByMagic(block)).toBeNull();
    });
});

describe('FileUtils.detectViewerType — routing for issue #56 archive types', () => {
    it.each(SIGNATURES)('routes $name to the archive viewer', async ({ bytes, fileName }) => {
        const file = makeFile(bytes, fileName);
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(true);
    });

    it('routes .tgz by the gzip signature on the wrapping stream', async () => {
        // tar.gz is a tar inside gzip — the outer GZ signature wins, which
        // is fine because libarchive transparently unwraps it.
        const file = makeFile([0x1F, 0x8B, 0x08, 0x00], 'payload.tgz');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('GZIP');
    });

    it('routes .tar.gz by the gzip signature on the wrapping stream', async () => {
        const file = makeFile([0x1F, 0x8B, 0x08, 0x00], 'archive.tar.gz');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(true);
    });

    it('falls back to the archive extension for a 7Z file with stripped header', async () => {
        // No leading 7Z bytes — verify the extension fallback still routes.
        const file = makeFile([0x00, 0x00, 0x00, 0x00], 'archive.7z');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(false);
        expect(result.reason).toContain('archive extension fallback');
    });

    it('falls back to the archive extension for a RAR file with stripped header', async () => {
        const file = makeFile([0x00, 0x00, 0x00, 0x00], 'archive.rar');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(false);
    });

    it('falls back to the archive extension for a TAR file with no USTAR magic', async () => {
        // Tiny file with no USTAR magic — the .tar extension fallback still
        // routes it to the archive viewer.
        const file = makeFile([0x00, 0x00, 0x00, 0x00], 'archive.tar');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(false);
    });

    it('does not route a JPEG that happens to be named .tar to the archive viewer', async () => {
        // Signature wins over extension: the JPEG SOI bytes are identified
        // first, so a maliciously- or mistakenly-named `.tar` cannot
        // hijack the image viewer's routing.
        const file = makeFile([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46], 'photo.tar');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.imageViewer');
        expect(result.matchedBySignature).toBe(true);
    });
});

describe('formatArchiveLabel — header label per format', () => {
    it.each<[ArchiveFormat, string]>([
        ['zip', 'ZIP'],
        ['rar', 'RAR'],
        ['sevenZip', '7Z'],
        ['tar', 'TAR'],
        ['tarGz', 'TAR.GZ'],
        ['tarBz2', 'TAR.BZ2'],
        ['tarXz', 'TAR.XZ'],
        ['gz', 'GZ'],
        ['bz2', 'BZ2'],
        ['xz', 'XZ'],
        ['dmg', 'DMG'],
        ['jar', 'JAR'],
        ['apk', 'APK']
    ])('labels %s as "%s"', (format, expected) => {
        expect(formatArchiveLabel(format)).toBe(expected);
    });

    it('renders a recognisable label for every issue #56 signature', () => {
        for (const { format, label } of SIGNATURES) {
            expect(formatArchiveLabel(format)).toBe(label);
        }
    });
});

describe('detectArchiveFormat — magic + extension combined', () => {
    it('prefers the magic-byte sniff over the extension', () => {
        // Bytes look like 7-Zip but the file is named .zip — magic wins,
        // matching what libarchive will be reading.
        const bytes = new Uint8Array([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]);
        expect(detectArchiveFormat('archive.zip', bytes)).toBe('sevenZip');
    });

    it('falls back to the extension when the buffer is empty or generic', () => {
        expect(detectArchiveFormat('archive.7z', new Uint8Array(0))).toBe('sevenZip');
        expect(detectArchiveFormat('archive.rar', new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBe('rar');
        expect(detectArchiveFormat('archive.tar', null)).toBe('tar');
    });

    it('returns null when neither path knows the format', () => {
        expect(detectArchiveFormat('photo.png', new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    });

    it('agrees with the extension classifier when no buffer is supplied', () => {
        // Spot-check a few — full coverage for the extension classifier
        // lives in archiveExtensionMapping.test.ts.
        expect(detectArchiveFormat('build.tar.gz')).toBe(detectArchiveFormatByExtension('build.tar.gz'));
        expect(detectArchiveFormat('archive.7z')).toBe(detectArchiveFormatByExtension('archive.7z'));
    });
});
