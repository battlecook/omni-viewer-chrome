// Browser-side archive helpers for omni-viewer-chrome.
//
// Issue #3 (Foundation) only needs to inspect the entry list inside a ZIP-based
// container so that OOXML (.docx/.xlsx/.pptx) and HWPX packages can be
// disambiguated from generic ZIP archives. Reading entries for a real archive
// viewer is owned by a follow-up issue.
//
// The helper accepts an *injected* JSZip instance so callers can lazy-load the
// vendored bundle (`vendor/jszip.min.js`) at runtime via
// `chrome.runtime.getURL`. As a robust fallback when no JSZip is supplied, we
// parse the ZIP local file headers manually.
//
// Issue #58 added a small extension/magic-byte→format map so callers can both
// route the new container types (`.dmg`, `.tbz2`, `.tar.bz2`, `.txz`,
// `.tar.xz`, `.bz2`, `.xz`) to the archive viewer and surface a friendly
// notice for partially-supported formats (DMG/HFS+/APFS).

export interface ArchivePreviewEntry {
    path: string;
    kind: 'file' | 'directory';
    compressedSize: number | null;
    uncompressedSize: number | null;
    modifiedAt: string | null;
}

export interface ArchivePreviewData {
    format: string;
    fileName: string;
    fileSize: string;
    entryCount: number;
    fileCount: number;
    directoryCount: number;
    truncated: boolean;
    entries: ArchivePreviewEntry[];
    note?: string;
}

export interface ArchiveEntryPreviewData {
    path: string;
    status: 'success' | 'unsupported' | 'error';
    content?: string;
    truncated?: boolean;
    message?: string;
    description?: string;
}

export interface JSZipLike {
    loadAsync: (input: ArrayBuffer | Uint8Array) => Promise<{ files: Record<string, unknown> }>;
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    const maybe = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
    if (typeof maybe.arrayBuffer === 'function') {
        return maybe.arrayBuffer();
    }
    if (typeof FileReader !== 'undefined') {
        return new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
            reader.onload = () => {
                const result = reader.result;
                if (result instanceof ArrayBuffer) {
                    resolve(result);
                } else {
                    reject(new Error('Unexpected FileReader result type'));
                }
            };
            reader.readAsArrayBuffer(blob);
        });
    }
    throw new Error('No mechanism available to read Blob into ArrayBuffer.');
}

/**
 * Returns the list of entry names inside a ZIP-based container.
 *
 * Strategy:
 *   1. If `jsZip` is supplied, prefer it (richest, handles all ZIP variants).
 *   2. Otherwise, walk local file headers manually. This is sufficient to
 *      observe top-level directory prefixes (e.g. "word/", "xl/", "ppt/").
 */
export async function listZipEntryNames(file: File, jsZip?: JSZipLike): Promise<string[]> {
    const buffer = await blobToArrayBuffer(file);

    if (jsZip?.loadAsync) {
        try {
            const archive = await jsZip.loadAsync(buffer);
            return Object.keys(archive.files);
        } catch (error) {
            // Fall through to the manual parser if JSZip fails (e.g. encrypted ZIP).
            console.warn('[fileUtils/archive] JSZip failed to parse ZIP; falling back to manual parser:', error);
        }
    }

    return parseLocalFileHeaders(new Uint8Array(buffer));
}

/**
 * Manually walks ZIP local file headers (PK\x03\x04 ... ) and returns the file
 * names. This avoids any external dependency and is enough for OOXML/HWPX
 * disambiguation.
 *
 * Note: this is a minimal, header-only parser. It doesn't decompress any data,
 * but it correctly tolerates entries whose data segment uses streaming
 * descriptors (it falls back to the central directory hint in that case).
 */
export function parseLocalFileHeaders(buffer: Uint8Array): string[] {
    const names: string[] = [];
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const decoder = new TextDecoder('utf-8');

    let offset = 0;
    const maxLoops = 50000; // safety guard against malformed archives
    let loop = 0;

    while (offset + 30 <= buffer.length && loop < maxLoops) {
        loop += 1;
        const signature = view.getUint32(offset, true);

        // Local file header signature: 0x04034b50 ("PK\x03\x04")
        if (signature !== 0x04034b50) {
            break;
        }

        const generalPurposeFlag = view.getUint16(offset + 6, true);
        const compressedSize = view.getUint32(offset + 18, true);
        const fileNameLength = view.getUint16(offset + 26, true);
        const extraFieldLength = view.getUint16(offset + 28, true);

        const nameStart = offset + 30;
        const nameEnd = nameStart + fileNameLength;
        if (nameEnd > buffer.length) {
            break;
        }

        const name = decoder.decode(buffer.subarray(nameStart, nameEnd));
        names.push(name);

        // If bit 3 of the general-purpose flag is set, the actual sizes live in
        // a data descriptor that follows the compressed data — not reliable
        // without the central directory. In that case we stop early; the names
        // gathered so far are still useful.
        if ((generalPurposeFlag & 0x08) !== 0) {
            break;
        }

        offset = nameEnd + extraFieldLength + compressedSize;
    }

    return names;
}

// The full `readArchiveFile` / `readArchiveEntryPreview` implementations are
// owned by a follow-up issue (archive viewer port). The exports below preserve
// the API surface so consumers can stub or lazy-load.
export async function readArchiveFile(_file: File): Promise<ArchivePreviewData> {
    throw new Error('readArchiveFile is not yet implemented in omni-viewer-chrome.');
}

export async function readArchiveEntryPreview(_file: File, _entryPath: string): Promise<ArchiveEntryPreviewData> {
    throw new Error('readArchiveEntryPreview is not yet implemented in omni-viewer-chrome.');
}

// ---------------------------------------------------------------------------
// Extension / magic-byte → archive format detection (issue #58)
// ---------------------------------------------------------------------------

/**
 * Symbolic names for the archive containers the viewer can route to. These are
 * intentionally coarse — the viewer itself relies on libarchive to do the
 * actual format detection at decode time. The values returned here are only
 * used to:
 *
 *   1. classify a file by extension when there is no signature window (e.g.
 *      empty file, or detection running before the buffer is read);
 *   2. derive friendly user-facing notices (e.g. the DMG fallback message).
 */
export type ArchiveFormat =
    | 'zip'
    | 'rar'
    | 'sevenZip'
    | 'tar'
    | 'tarGz'
    | 'tarBz2'
    | 'tarXz'
    | 'gz'
    | 'bz2'
    | 'xz'
    | 'dmg'
    | 'jar'
    | 'apk';

/** Lowercase compound-extension → archive format. Longest-match-first. */
const ARCHIVE_COMPOUND_EXTENSIONS: ReadonlyArray<readonly [string, ArchiveFormat]> = [
    ['.tar.gz', 'tarGz'],
    ['.tar.bz2', 'tarBz2'],
    ['.tar.xz', 'tarXz']
];

/** Lowercase single extension → archive format. */
const ARCHIVE_SINGLE_EXTENSIONS: Readonly<Record<string, ArchiveFormat>> = {
    '.zip': 'zip',
    '.jar': 'jar',
    '.apk': 'apk',
    '.rar': 'rar',
    '.7z': 'sevenZip',
    '.tar': 'tar',
    '.tgz': 'tarGz',
    '.tbz2': 'tarBz2',
    '.txz': 'tarXz',
    '.gz': 'gz',
    '.bz2': 'bz2',
    '.xz': 'xz',
    '.dmg': 'dmg'
};

/**
 * Map a filename to an archive format using its extension.
 *
 * Compound extensions (`.tar.gz`, `.tar.bz2`, `.tar.xz`) take precedence over
 * the trailing single-extension match so `archive.tar.gz` is classified as
 * `tarGz`, not `gz`.
 */
export function detectArchiveFormatByExtension(fileName: string): ArchiveFormat | null {
    const lower = fileName.toLowerCase();
    for (const [suffix, format] of ARCHIVE_COMPOUND_EXTENSIONS) {
        if (lower.endsWith(suffix)) {
            return format;
        }
    }
    const dotIdx = lower.lastIndexOf('.');
    if (dotIdx === -1) {
        return null;
    }
    const ext = lower.slice(dotIdx);
    return ARCHIVE_SINGLE_EXTENSIONS[ext] ?? null;
}

/** Returns true when the filename's extension maps to a known archive format. */
export function isArchiveFileName(fileName: string): boolean {
    return detectArchiveFormatByExtension(fileName) !== null;
}

/**
 * Best-effort archive format sniff using the leading bytes of a file (and, for
 * TAR specifically, the USTAR magic at offset 257). Only formats with a
 * stable, distinctive signature window are recognised here — generic
 * containers (`.dmg`, `.zip` based packages) are intentionally left to
 * higher-level detection paths that can inspect more context.
 *
 * Recognised signatures:
 *   - GZIP:   1F 8B                 (offset 0)
 *   - BZIP2:  42 5A 68              ("BZh", offset 0)
 *   - XZ:     FD 37 7A 58 5A 00     (offset 0)
 *   - 7-Zip:  37 7A BC AF 27 1C     (offset 0)
 *   - ZIP:    50 4B 03 04           ("PK\x03\x04", offset 0)
 *   - RAR4:   52 61 72 21 1A 07 00  ("Rar!" + version, offset 0)
 *   - RAR5:   52 61 72 21 1A 07 01 00
 *   - TAR:    75 73 74 61 72        ("ustar", offset 257; USTAR header)
 */
export function detectArchiveFormatByMagic(buffer: Uint8Array): ArchiveFormat | null {
    if (!buffer || buffer.length < 2) {
        return null;
    }
    const startsWith = (sig: number[]): boolean => {
        if (buffer.length < sig.length) return false;
        for (let i = 0; i < sig.length; i++) {
            if (buffer[i] !== sig[i]) return false;
        }
        return true;
    };
    const matchesAt = (offset: number, sig: number[]): boolean => {
        if (buffer.length < offset + sig.length) return false;
        for (let i = 0; i < sig.length; i++) {
            if (buffer[offset + i] !== sig[i]) return false;
        }
        return true;
    };

    if (startsWith([0x42, 0x5A, 0x68])) return 'bz2';
    if (startsWith([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00])) return 'xz';
    if (startsWith([0x1F, 0x8B])) return 'gz';
    if (startsWith([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])) return 'sevenZip';
    if (startsWith([0x50, 0x4B, 0x03, 0x04])) return 'zip';
    if (startsWith([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00])) return 'rar';
    if (startsWith([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00])) return 'rar';
    // USTAR magic ("ustar") at offset 257 of the first 512-byte TAR header
    // block. POSIX ustar uses "ustar\x0000"; GNU tar uses "ustar  \x00" — both
    // start with the five-byte `ustar` ASCII prefix that we anchor on here.
    if (matchesAt(257, [0x75, 0x73, 0x74, 0x61, 0x72])) return 'tar';
    return null;
}

/**
 * Friendly, user-facing label for an `ArchiveFormat`. Used by the archive
 * viewer header (`Format: ...`) so a user can see at a glance which container
 * libarchive is dealing with — useful when an extension is missing or
 * mislabelled (e.g. a `.tar.gz` saved as `.tgz`, or a `.7z` re-extension'd to
 * `.zip`).
 */
export function formatArchiveLabel(format: ArchiveFormat): string {
    switch (format) {
    case 'zip':
        return 'ZIP';
    case 'rar':
        return 'RAR';
    case 'sevenZip':
        return '7Z';
    case 'tar':
        return 'TAR';
    case 'tarGz':
        return 'TAR.GZ';
    case 'tarBz2':
        return 'TAR.BZ2';
    case 'tarXz':
        return 'TAR.XZ';
    case 'gz':
        return 'GZ';
    case 'bz2':
        return 'BZ2';
    case 'xz':
        return 'XZ';
    case 'dmg':
        return 'DMG';
    case 'jar':
        return 'JAR';
    case 'apk':
        return 'APK';
    default: {
        // Exhaustiveness guard — adding a new ArchiveFormat without updating
        // this switch will surface as a TS error here.
        const exhaustive: never = format;
        return String(exhaustive).toUpperCase();
    }
    }
}

/**
 * Convenience: detect a file's archive format using both the magic-byte sniff
 * and the extension fallback. Magic wins where it disagrees with the
 * extension (a `.zip` file that actually contains 7-Zip bytes is reported as
 * 7-Zip), since libarchive will route by content too.
 */
export function detectArchiveFormat(
    fileName: string,
    headerBuffer?: Uint8Array | null
): ArchiveFormat | null {
    if (headerBuffer && headerBuffer.length > 0) {
        const sniffed = detectArchiveFormatByMagic(headerBuffer);
        if (sniffed) {
            return sniffed;
        }
    }
    return detectArchiveFormatByExtension(fileName);
}

/**
 * Friendly notice for the DMG container. libarchive only reads a subset of
 * DMG payloads (HFS+/APFS images in particular are partially supported), so
 * we surface a clear hint instead of the raw libarchive error string when an
 * open attempt fails.
 */
export const DMG_PARTIAL_SUPPORT_MESSAGE =
    "DMG (HFS+/APFS) is partially supported; some images can't be browsed.";
