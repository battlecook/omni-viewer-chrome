// Browser-side Word helpers for omni-viewer-chrome.
//
// Issue #3 originally only required this module to exist as a sibling
// of the other fileUtils helpers. Issue #44 extends it with .doc-vs-.docx
// classification (extension first, then magic-byte fallback) so the
// viewer entry point can dispatch between the docx-preview render
// path and the legacy CFB parser added in `src/utils/docBinaryParser.ts`.
//
// What this file gives callers:
//   - `WordSourceFormat` -- a tiny union describing the on-disk format.
//   - `detectWordFormat(file)` -- async helper that looks at the file
//     name first (cheap), and only reads the first 8 bytes when the
//     extension is missing or ambiguous. Returns `'doc'` only when the
//     CFB magic (`D0 CF 11 E0 A1 B1 1A E1`) matches.
//   - `WORD_DOC_MAGIC` / `WORD_DOC_MAGIC_LENGTH` -- exported constants
//     for tests and ad-hoc routing checks.
//
// We *don't* implement `readWordFile()` here. The viewer entry point
// (`src/templates/word/js/wordViewerMain.ts`) drives the format
// dispatch directly using `detectWordFormat`.

import { isCfbMagic } from '../docBinaryParser';

export type WordSourceFormat = 'doc' | 'docx' | 'unknown';

/**
 * MS-CFB compound-file signature.
 *
 * NOTE: this signature is *also* present at the start of .xls / .ppt /
 * .msg / .vsd / etc. The legacy Office binary container is shared
 * across the whole suite, so byte-level detection alone cannot
 * uniquely identify a Word document - callers must combine the magic
 * check with the file extension or MIME type.
 */
export const WORD_DOC_MAGIC = Object.freeze([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1
] as const);
export const WORD_DOC_MAGIC_LENGTH = WORD_DOC_MAGIC.length;

/**
 * DOCX is a ZIP container, but a "PK" signature alone is shared with
 * every other OOXML format and every plain .zip. We don't try to
 * disambiguate those here; the route layer handles archive disambiguation
 * separately. For Word's purposes a `.docx` extension is sufficient.
 */
const PK_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

/**
 * Cheap synchronous classifier when only the file name is available
 * (e.g. drag-and-drop where the read hasn't happened yet, or unit
 * tests).
 */
export function detectWordFormatByName(name: string): WordSourceFormat {
    const lower = (name || '').toLowerCase();
    if (lower.endsWith('.docx')) return 'docx';
    if (lower.endsWith('.doc')) return 'doc';
    if (lower.endsWith('.dot')) return 'doc';  // legacy template
    if (lower.endsWith('.dotx')) return 'docx'; // OOXML template
    return 'unknown';
}

/**
 * Returns `true` when the supplied byte window looks like a CFB
 * compound-file container. Used as a magic-byte fallback when the file
 * name has no recognisable extension.
 *
 * Re-exported via `docBinaryParser.isCfbMagic`. Kept here as a thin
 * wrapper so callers don't reach into the parser module just for the
 * magic constant.
 */
export function looksLikeCfbContainer(
    bytes: Uint8Array | ArrayBuffer
): boolean {
    return isCfbMagic(bytes);
}

/**
 * Returns `true` when the supplied byte window starts with the ZIP
 * local file header signature ("PK\x03\x04"). Doesn't try to verify
 * the entry layout - any caller that needs DOCX-vs-OOXML
 * disambiguation should crack the archive open.
 */
export function looksLikeZipContainer(
    bytes: Uint8Array | ArrayBuffer
): boolean {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (buf.length < PK_MAGIC.length) return false;
    for (let i = 0; i < PK_MAGIC.length; i++) {
        if (buf[i] !== PK_MAGIC[i]) return false;
    }
    return true;
}

/**
 * Async classifier that prefers extension, then falls back to a
 * magic-byte sniff of the first 8 bytes.
 *
 * - `.docx` / `.dotx` -> `'docx'`
 * - `.doc` / `.dot`  -> `'doc'`
 * - otherwise read 8 bytes and look for CFB / ZIP signatures.
 */
export async function detectWordFormat(file: File): Promise<WordSourceFormat> {
    const byName = detectWordFormatByName(file.name);
    if (byName !== 'unknown') return byName;
    try {
        const head = await file
            .slice(0, WORD_DOC_MAGIC_LENGTH)
            .arrayBuffer();
        const bytes = new Uint8Array(head);
        if (looksLikeCfbContainer(bytes)) return 'doc';
        if (looksLikeZipContainer(bytes)) return 'docx';
    } catch {
        // File might be revoked / detached; fall through to unknown.
    }
    return 'unknown';
}

// --- Compatibility shim ------------------------------------------------
//
// The original stub exported `WordFileData` / `readWordFile()` for
// future use. We keep `WordFileData` exported (other modules may type
// against it) but `readWordFile()` is now a thin wrapper around
// `detectWordFormat` for callers that need a single async entry.

export interface WordFileData {
    renderer: 'docx-preview' | 'legacy-html';
    format: WordSourceFormat;
    fileSize: string;
}

function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export async function readWordFile(file: File): Promise<WordFileData> {
    const format = await detectWordFormat(file);
    return {
        renderer: format === 'doc' ? 'legacy-html' : 'docx-preview',
        format,
        fileSize: formatFileSize(file.size)
    };
}
