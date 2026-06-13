// Browser-only legacy .ppt (PowerPoint 97-2003) parser for omni-viewer-chrome
// (issues #48 and #78).
//
// This module is a port of the relevant subset of the VSCode build's
// `src/utils/pptBinaryParser.ts` (~3500 LOC, Buffer-based). The VSCode
// parser turns a .ppt deck into a fully-positioned slide model with shape
// bounds, OfficeArt geometry, picture extraction (PNG / JPEG BLIPs),
// outline-vs-shape text reconciliation, placeholder inheritance, colour
// scheme resolution, etc.
//
// Issue #48 shipped the text-only baseline:
//   1. CFB (Compound File Binary) container parsing - locate the
//      `PowerPoint Document` stream inside the OLE container.
//   2. Walk the PPT record tree (header = ver/inst + type + length).
//   3. Find every `RT_Slide` (1006) container record.
//   4. Inside each slide container, decode `TextCharsAtom` (4000 -
//      UTF-16LE) and `TextBytesAtom` (4008 - single-byte ANSI) atoms
//      into plain strings.
//
// Issue #78 extends the baseline (Tier 1):
//   5. Read the `DocumentAtom` (RT_DocumentAtom 1001) to surface
//      presentation-wide slide dimensions in raw + px form.
//   6. Read `PersistDirectoryAtom`-equivalent ordering — we walk the
//      `SlideListWithText` (4080) -> `SlidePersistAtom` (1011) chain
//      that lives under the Document container, since real
//      RT_PersistDirectoryAtom (6002) decoding is out of scope.
//   7. Walk OfficeArt `SpContainer` (0xF004) inside each slide to
//      extract shape bounds (`ClientAnchor` 0xF00F or `ChildAnchor`
//      0xF010) and attribute each text atom to its enclosing shape.
//   8. Scan the `Pictures` stream for PNG / JPEG / DIB BLIPs and build
//      a `blipId -> PptPictureAsset` map keyed by the OfficeArt
//      BStoreEntry order; surface picture references via shape pid
//      properties (opid 0x0104 / 0x0186).
//
// Deferred (intentionally not ported yet - tracked in `docs/ppt-parity.md`):
//   - Master / layout / theme inheritance and template walk.
//   - Per-slide colour scheme resolution.
//   - Outline-vs-shape text reconciliation (still surfaces every text
//     atom inside the slide container, in record order).
//   - Bullet glyph rendering for legacy bullet markers.
//   - Decorative-shape rendering (only text + pictures land in #78).
//   - EMF / WMF BLIPs (browser cannot decode them).
//   - Slide transitions / animations.
//   - Per-line ANSI code-page scoring (we do whole-payload scoring
//     across `windows-1252` / `euc-kr` / `shift_jis` once per atom).
//
// Browser constraints:
//   - No `Buffer`. We work over `Uint8Array` + `DataView`.
//   - No `fs`. Caller supplies an `ArrayBuffer` from `File.arrayBuffer()`.
//   - No npm deps. Just `TextDecoder` for UTF-16 / CP949 / SJIS.

import type {
    CfbEntry,
    CfbReader,
    PptParseResult,
    PptPictureAsset,
    PptPresentationMetrics,
    PptRecord,
    PptShapeBounds,
    PptSlideElement,
    PptSlideModel
} from './pptBinaryTypes';

// CFB / OLE2 magic. Same constant the .doc and .xls parsers use; we keep
// a private copy here rather than importing `parseCfb` from
// `docBinaryParser.ts` because the .doc parser bakes in Word-specific
// directory-name normalisation (it strips spaces from names so
// "WordDocument" survives a UTF-16 round-trip). The PPT directory uses
// names like "PowerPoint Document" *with* the space, so we keep our
// own copy that only strips NUL terminators. This keeps the two
// parsers from accidentally drifting out of sync.
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

// FAT sentinels appear as -2 (ENDOFCHAIN = 0xFFFFFFFE) and -1 (FREESECT =
// 0xFFFFFFFF) when read via DataView.getInt32. Compare against the
// signed form so we never need a `>>> 0` round-trip.
const FAT_ENDOFCHAIN = -2;
const FAT_FREESECT = -1;

// PPT record types we recognise. There are dozens more - these are just
// the subset relevant to the text + bounds + picture paths.
const RT_DOCUMENT = 1000;
const RT_DOCUMENT_ATOM = 1001; // slide / notes dimensions
const RT_SLIDE_PERSIST_ATOM = 1011; // entry inside SlideListWithText
const RT_SLIDE = 1006;
const RT_SLIDE_LIST_WITH_TEXT = 4080; // child of Document, holds slide persist order
const RT_TEXT_CHARS_ATOM = 4000; // UTF-16LE text
const RT_TEXT_BYTES_ATOM = 4008; // single-byte ANSI text
const RT_TEXT_HEADER_ATOM = 3999; // textType (title / body / etc)
const RT_COLOR_SCHEME_ATOM = 2032;

// OfficeArt record types (msofbt*). The full set is described in MS-ODRAW;
// we only need the records that carry shape geometry + picture references.
const OFFICE_ART_SP_CONTAINER = 0xf004; // msofbtSpContainer
const OFFICE_ART_CLIENT_ANCHOR = 0xf010; // msofbtClientAnchor (rect2D / int16)
const OFFICE_ART_ANCHOR_RECT = 0xf00f; // msofbtAnchor (rect2D / int32) - alt anchor
const OFFICE_ART_CLIENT_TEXTBOX = 0xf00d; // msofbtClientTextbox
const OFFICE_ART_OPT = 0xf00b; // msofbtOPT - shape property table
const OFFICE_ART_BSTORE_ENTRY = 0xf007; // msofbtBSE - BLIP store entry

// Single-character constants we use for filtering control bytes.
// Computed at module-load via String.fromCharCode so the source file
// stays free of literal control bytes (which break some editors and
// `grep`/`file`-style tooling that flags files containing NULs as
// binary). Same trick the .doc / .xls parsers use.
const NUL_CHAR = String.fromCharCode(0);
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

// ANSI fallbacks for `TextBytesAtom`. CP949 covers Korean (the EUC-KR
// label in `TextDecoder` decodes the CP949 byte range correctly for
// every deck we care about). Shift-JIS covers Japanese.
const ANSI_DECODER_LABELS = ['windows-1252', 'euc-kr', 'shift_jis'] as const;
type AnsiLabel = (typeof ANSI_DECODER_LABELS)[number];

// Default presentation dimensions when DocumentAtom is missing. Matches
// PowerPoint's 4:3 default (10" x 7.5" at 72 DPI -> 720x540 px).
const DEFAULT_SLIDE_WIDTH_PX = 720;
const DEFAULT_SLIDE_HEIGHT_PX = 540;

// Conversion factor for legacy DocumentAtom "master units" (1/576 inch).
// At 96 DPI, 1 inch = 96 px, so 1 master unit = 96/576 = 1/6 px.
const MASTER_UNITS_PER_INCH = 576;
const PX_PER_INCH = 96;
const MASTER_UNIT_TO_PX = PX_PER_INCH / MASTER_UNITS_PER_INCH; // = 1/6
// EMU = 1/914400 inch; some atoms use this instead. 1 EMU = 1/9525 px @ 96 DPI.
const EMU_PER_PX = 9525;

// PNG / JPEG / DIB BLIP record-type ranges. The OfficeArt BLIP family
// runs 0xF018..0xF117 (per MS-ODRAW); we map a subset to MIME types.
// Note: in PPT-2003 the *record* types are RT_BlipJPEG (0xF01D),
// RT_BlipPNG (0xF01E), RT_BlipDIB (0xF01F) in the documentation, but
// in the on-disk Pictures stream the OfficeArt records use slightly
// different ranges (the spec calls them msofbtBlip variants). We scan
// for image-format magic bytes inside each BSE entry instead of
// branching on the record type; this is simpler and handles the
// minor divergence between PPT-2000 and PPT-2003 BLIP layouts.

// ---------------------------------------------------------------------------
// Buffer / DataView helpers
// ---------------------------------------------------------------------------

function toUint8(input: ArrayBuffer | Uint8Array): Uint8Array {
    return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function asDataView(buf: Uint8Array): DataView {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

function readUInt16LE(buf: Uint8Array, offset: number): number {
    return asDataView(buf).getUint16(offset, true);
}

function readUInt32LE(buf: Uint8Array, offset: number): number {
    return asDataView(buf).getUint32(offset, true);
}

function readInt16LE(buf: Uint8Array, offset: number): number {
    return asDataView(buf).getInt16(offset, true);
}

function readInt32LE(buf: Uint8Array, offset: number): number {
    return asDataView(buf).getInt32(offset, true);
}

function concatUint8(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function decodeUtf16Le(buf: Uint8Array): string {
    return new TextDecoder('utf-16le').decode(buf);
}

function stripNulChars(text: string): string {
    return text.split(NUL_CHAR).join('');
}

const ANSI_DECODER_CACHE: Partial<Record<AnsiLabel, TextDecoder>> = {};
function getAnsiDecoder(label: AnsiLabel): TextDecoder {
    let cached = ANSI_DECODER_CACHE[label];
    if (!cached) {
        cached = new TextDecoder(label, { fatal: false });
        ANSI_DECODER_CACHE[label] = cached;
    }
    return cached;
}

/** Cheap "is this byte stream plausibly a CFB file" probe. */
export function isCfbMagic(input: ArrayBuffer | Uint8Array): boolean {
    const buf = toUint8(input);
    if (buf.length < 8) return false;
    for (let i = 0; i < CFB_SIGNATURE.length; i++) {
        if (buf[i] !== CFB_SIGNATURE[i]) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// CFB parser
//
// MS-CFB describes the OLE2 container: 512-byte (or 4096-byte) sectors,
// a sector-allocation table (FAT) reached via the DIFAT, a directory
// stream of 128-byte entries, and a mini-stream + mini-FAT for streams
// smaller than `miniCutoff`.
//
// We only need the read side: build the FAT, follow chains, decode the
// directory, and expose `getStream(name)` for the `PowerPoint Document`
// (and optionally `Current User` / `Pictures`) streams.
//
// NOTE: we keep this private to the PPT parser even though `docBinaryParser`
// has its own copy. The two parsers diverge on directory-name handling
// (the .doc parser strips spaces - the .ppt directory entries contain
// real spaces, e.g. "PowerPoint Document"), so a shared helper would
// need to be parameterised. Per the issue brief, we elect to keep the
// minimal duplication rather than introduce a shared `cfbContainer.ts`.
// ---------------------------------------------------------------------------

export function parseCfb(input: ArrayBuffer | Uint8Array): CfbReader {
    const file = toUint8(input);
    if (file.length < 512) {
        throw new Error('Invalid CFB file: too small.');
    }
    if (!isCfbMagic(file)) {
        throw new Error('Invalid CFB signature.');
    }

    const sectorShift = readUInt16LE(file, 30);
    const miniSectorShift = readUInt16LE(file, 32);
    const sectorSize = 1 << sectorShift;
    const miniSectorSize = 1 << miniSectorShift;

    const numFatSectors = readUInt32LE(file, 44);
    const firstDirSector = readInt32LE(file, 48);
    const miniCutoff = readUInt32LE(file, 56);
    const firstMiniFatSector = readInt32LE(file, 60);
    const numMiniFatSectors = readUInt32LE(file, 64);
    const firstDifatSector = readInt32LE(file, 68);
    const numDifatSectors = readUInt32LE(file, 72);

    const readSector = (sid: number): Uint8Array => {
        const offset = (sid + 1) * sectorSize;
        if (offset < 0 || offset + sectorSize > file.length) {
            return new Uint8Array(0);
        }
        return file.subarray(offset, offset + sectorSize);
    };

    // ---- DIFAT ---------------------------------------------------------
    const difat: number[] = [];
    for (let i = 0; i < 109; i++) {
        const sid = readInt32LE(file, 76 + i * 4);
        if (sid !== -1) difat.push(sid);
    }
    let nextDifat = firstDifatSector;
    for (
        let i = 0;
        i < numDifatSectors && nextDifat !== FAT_ENDOFCHAIN && nextDifat !== -1;
        i++
    ) {
        const sector = readSector(nextDifat);
        if (sector.length === 0) break;
        const entriesPerSector = sectorSize / 4 - 1;
        for (let j = 0; j < entriesPerSector; j++) {
            const sid = readInt32LE(sector, j * 4);
            if (sid !== -1) difat.push(sid);
        }
        nextDifat = readInt32LE(sector, sectorSize - 4);
    }

    // ---- FAT -----------------------------------------------------------
    const fatSectors = difat.slice(0, numFatSectors);
    const fat: number[] = [];
    for (const sid of fatSectors) {
        const sector = readSector(sid);
        if (sector.length === 0) continue;
        for (let i = 0; i < sectorSize; i += 4) {
            fat.push(readInt32LE(sector, i));
        }
    }

    const readChain = (startSid: number): Uint8Array => {
        if (startSid < 0 || startSid === FAT_ENDOFCHAIN) {
            return new Uint8Array(0);
        }
        const chunks: Uint8Array[] = [];
        const visited = new Set<number>();
        let sid = startSid;
        while (sid >= 0 && sid !== FAT_ENDOFCHAIN && sid !== FAT_FREESECT) {
            if (visited.has(sid) || sid >= fat.length) break;
            visited.add(sid);
            const sector = readSector(sid);
            if (sector.length === 0) break;
            chunks.push(sector);
            sid = fat[sid];
        }
        return concatUint8(chunks);
    };

    // ---- Directory -----------------------------------------------------
    const dirStream = readChain(firstDirSector);
    const entries: CfbEntry[] = [];
    for (let offset = 0; offset + 128 <= dirStream.length; offset += 128) {
        const nameLength = readUInt16LE(dirStream, offset + 64);
        const nameBytes = dirStream.subarray(
            offset,
            offset + Math.max(0, nameLength - 2)
        );
        // Strip embedded NUL terminators from the UTF-16 directory name.
        // Unlike the .doc parser we do NOT collapse spaces - PPT stream
        // names use them literally (e.g. "PowerPoint Document",
        // "Current User"), so we only drop NUL padding bytes.
        const name = stripNulChars(decodeUtf16Le(nameBytes));
        const type = dirStream[offset + 66];
        const startSector = readInt32LE(dirStream, offset + 116);
        const sizeLow = readUInt32LE(dirStream, offset + 120);
        const sizeHigh = readUInt32LE(dirStream, offset + 124);
        // .ppt files almost never exceed 4 GB; if the high word is
        // non-zero we treat the low 32 bits as the size and rely on
        // downstream bounds checks.
        void sizeHigh;
        const size = sizeLow;
        entries.push({ name, type, startSector, size });
    }

    // ---- Mini stream ---------------------------------------------------
    const root = entries.find((entry) => entry.type === 5);
    const miniStream = root
        ? readChain(root.startSector).subarray(0, root.size)
        : new Uint8Array(0);
    const miniFatData = readChain(firstMiniFatSector);
    const miniFat: number[] = [];
    for (
        let i = 0;
        i + 4 <= miniFatData.length && i / 4 < numMiniFatSectors * (sectorSize / 4);
        i += 4
    ) {
        miniFat.push(readInt32LE(miniFatData, i));
    }

    const readMiniChain = (startMiniSid: number, size: number): Uint8Array => {
        if (startMiniSid < 0) return new Uint8Array(0);
        const chunks: Uint8Array[] = [];
        const visited = new Set<number>();
        let sid = startMiniSid;
        while (sid >= 0 && sid !== FAT_ENDOFCHAIN && sid !== FAT_FREESECT) {
            if (visited.has(sid) || sid >= miniFat.length) break;
            visited.add(sid);
            const start = sid * miniSectorSize;
            const end = start + miniSectorSize;
            if (start < 0 || end > miniStream.length) break;
            chunks.push(miniStream.subarray(start, end));
            sid = miniFat[sid];
        }
        return concatUint8(chunks).subarray(0, size);
    };

    const streamMap = new Map<string, CfbEntry>();
    for (const entry of entries) {
        if (entry.name && entry.type === 2) {
            streamMap.set(entry.name, entry);
        }
    }

    return {
        getStream(name: string): Uint8Array | null {
            const entry = streamMap.get(name);
            if (!entry) return null;
            if (entry.size < miniCutoff && root) {
                return readMiniChain(entry.startSector, entry.size);
            }
            return readChain(entry.startSector).subarray(0, entry.size);
        },
        listStreams() {
            return entries
                .filter((entry) => entry.name && entry.type === 2)
                .map((entry) => ({ name: entry.name, size: entry.size }));
        }
    };
}

// ---------------------------------------------------------------------------
// PPT record walker
//
// Each record header is 8 bytes:
//   u16 verInst   (low 4 bits: recVer, high 12 bits: recInstance)
//   u16 recType
//   u32 length    (size of the payload in bytes - header excluded)
//
// Container records carry `recVer == 0x0f` and their payload itself is
// a sequence of records. Atoms carry data we want to decode (text /
// styling / persistence info / etc).
// ---------------------------------------------------------------------------

export function parseRecords(buffer: Uint8Array, start: number, end: number): PptRecord[] {
    const records: PptRecord[] = [];
    const limit = Math.min(end, buffer.length);
    let offset = start;

    while (offset + 8 <= limit) {
        const verInst = readUInt16LE(buffer, offset);
        const recVer = verInst & 0x000f;
        const recInstance = (verInst >> 4) & 0x0fff;
        const recType = readUInt16LE(buffer, offset + 2);
        const length = readUInt32LE(buffer, offset + 4);
        const payloadOffset = offset + 8;
        const payloadEnd = payloadOffset + length;
        if (payloadEnd > limit) break;

        const record: PptRecord = {
            recType,
            recInstance,
            recVer,
            length,
            payloadOffset,
            payload: buffer.subarray(payloadOffset, payloadEnd)
        };

        if (recVer === 0x0f) {
            record.children = parseRecords(buffer, payloadOffset, payloadEnd);
        }

        records.push(record);
        offset = payloadEnd;
    }

    return records;
}

// ---------------------------------------------------------------------------
// Slide / text extraction
// ---------------------------------------------------------------------------

/** Walk the parsed record tree and return every `RT_Slide` (1006) record. */
export function collectSlideRecords(records: PptRecord[]): PptRecord[] {
    const out: PptRecord[] = [];
    const visit = (list: PptRecord[]): void => {
        for (const record of list) {
            if (record.recType === RT_SLIDE) {
                out.push(record);
            }
            if (record.children && record.children.length > 0) {
                visit(record.children);
            }
        }
    };
    visit(records);
    return out;
}

/**
 * Decode a single text atom (`TextCharsAtom` for UTF-16LE,
 * `TextBytesAtom` for single-byte ANSI). Returns `null` for record
 * types that aren't text atoms or for empty / mis-aligned payloads.
 */
export function decodeTextAtom(record: PptRecord): string | null {
    if (record.recType === RT_TEXT_CHARS_ATOM) {
        if (record.payload.length < 2 || record.payload.length % 2 !== 0) {
            return null;
        }
        const decoded = stripNulChars(decodeUtf16Le(record.payload));
        return decoded.length > 0 ? decoded : null;
    }

    if (record.recType === RT_TEXT_BYTES_ATOM) {
        if (record.payload.length === 0) return null;
        return decodeAnsiBest(record.payload);
    }

    return null;
}

/**
 * Try every supported ANSI code page and return the highest-scoring
 * decode. Bias is toward decodes that produce printable / Korean /
 * Japanese characters and away from decodes that emit replacement
 * characters (`U+FFFD`).
 */
function decodeAnsiBest(payload: Uint8Array): string {
    let best: { text: string; score: number } | null = null;
    for (const label of ANSI_DECODER_LABELS) {
        let text: string;
        try {
            text = getAnsiDecoder(label).decode(payload);
        } catch {
            continue;
        }
        const score = scoreDecodedText(text);
        if (best === null || score > best.score) {
            best = { text, score };
        }
    }
    return best ? stripNulChars(best.text) : '';
}

function scoreDecodedText(text: string): number {
    const normalized = stripNulChars(text || '').trim();
    if (!normalized) return 0;
    let score = 0;
    let readable = 0;
    for (let i = 0; i < normalized.length; i++) {
        const code = normalized.charCodeAt(i);
        const isBasicPrintable = code >= 32 && code <= 126;
        // Hangul Syllables - the dominant Korean range used by .ppt decks.
        const isKorean = code >= 0xac00 && code <= 0xd7a3;
        // Hiragana + Katakana + common CJK Unified.
        const isJapanese =
            (code >= 0x3040 && code <= 0x30ff) || (code >= 0x4e00 && code <= 0x9fff);
        if (isBasicPrintable || isKorean || isJapanese) {
            readable += 1;
        }
        if (isKorean || isJapanese) {
            score += 3;
        } else if (isBasicPrintable) {
            score += 1;
        } else if (normalized[i] === REPLACEMENT_CHAR) {
            score -= 3;
        }
    }
    return score + readable / Math.max(1, normalized.length);
}

/**
 * Walk a slide container's record tree and collect every text atom in
 * record order. We deliberately include atoms that live inside any
 * descendant container (typically `OfficeArtSpContainer` -> `ClientTextBox`
 * -> `TextHeaderAtom` -> ... -> `TextCharsAtom`). The viewer joins them
 * with newlines, so the order doesn't have to match the visual layout -
 * it just has to be stable.
 */
export function extractTextsFromSlide(record: PptRecord): string[] {
    const texts: string[] = [];
    const visit = (r: PptRecord): void => {
        const decoded = decodeTextAtom(r);
        if (decoded !== null) {
            const cleaned = decoded.replace(/\r\n?/g, '\n').trim();
            if (cleaned.length > 0) {
                texts.push(cleaned);
            }
        }
        if (r.children && r.children.length > 0) {
            for (const child of r.children) {
                visit(child);
            }
        }
    };
    if (record.children) {
        for (const child of record.children) {
            visit(child);
        }
    }
    return texts;
}

/**
 * Fallback path: when the document contains no `RT_Slide` containers
 * (corrupt deck, recovered file, weird embedded export) we surface every
 * text atom from the entire `PowerPoint Document` stream so the user
 * still sees *something*. We dedupe to avoid runaway repeats from
 * master-text atoms that show up on every slide.
 */
export function extractAllTexts(records: PptRecord[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (list: PptRecord[]): void => {
        for (const record of list) {
            const decoded = decodeTextAtom(record);
            if (decoded !== null) {
                const cleaned = decoded.replace(/\r\n?/g, '\n').trim();
                if (cleaned.length > 0 && !seen.has(cleaned)) {
                    seen.add(cleaned);
                    out.push(cleaned);
                }
            }
            if (record.children && record.children.length > 0) {
                visit(record.children);
            }
        }
    };
    visit(records);
    return out;
}

// ---------------------------------------------------------------------------
// Presentation metrics (RT_DocumentAtom 1001)
//
// DocumentAtom layout (first 16 bytes are the slide / notes dimensions):
//   u32 slideSizeX  (master units, 1/576 inch)
//   u32 slideSizeY
//   u32 notesSizeX
//   u32 notesSizeY
// We only need the first two. Some exporters write the values in EMU
// (1/914400 inch) instead of master units; both are handled by the
// `coordToPixels` heuristic - master-unit values are typically a few
// thousand (e.g. 5760 = 10"), EMU values are millions (e.g. 9144000 = 10").
// ---------------------------------------------------------------------------

export function extractPresentationMetrics(records: PptRecord[]): PptPresentationMetrics {
    const found = findDocumentAtom(records);
    if (found) {
        const widthPx = coordToPixels(found.rawWidth);
        const heightPx = coordToPixels(found.rawHeight);
        if (widthPx !== null && heightPx !== null) {
            return {
                rawWidth: found.rawWidth,
                rawHeight: found.rawHeight,
                widthPx,
                heightPx
            };
        }
    }
    return {
        rawWidth: DEFAULT_SLIDE_WIDTH_PX * MASTER_UNITS_PER_INCH / PX_PER_INCH,
        rawHeight: DEFAULT_SLIDE_HEIGHT_PX * MASTER_UNITS_PER_INCH / PX_PER_INCH,
        widthPx: DEFAULT_SLIDE_WIDTH_PX,
        heightPx: DEFAULT_SLIDE_HEIGHT_PX
    };
}

function findDocumentAtom(records: PptRecord[]): { rawWidth: number; rawHeight: number } | null {
    for (const record of records) {
        // RT_Document (1000) wraps RT_DocumentAtom (1001) directly.
        if (record.recType === RT_DOCUMENT && record.children && record.children.length > 0) {
            const documentAtom = record.children.find(
                (child) => child.recType === RT_DOCUMENT_ATOM && child.payload.length >= 8
            );
            if (documentAtom) {
                const rawWidth = readUInt32LE(documentAtom.payload, 0);
                const rawHeight = readUInt32LE(documentAtom.payload, 4);
                if (rawWidth > 0 && rawHeight > 0) {
                    return { rawWidth, rawHeight };
                }
            }
        }
        if (record.children && record.children.length > 0) {
            const nested = findDocumentAtom(record.children);
            if (nested) return nested;
        }
    }
    return null;
}

function coordToPixels(value: number): number | null {
    if (!Number.isFinite(value) || value <= 0) return null;
    // EMU range (millions): convert via EMU_PER_PX.
    if (value >= 1_000_000) {
        return Math.max(1, Math.round(value / EMU_PER_PX));
    }
    // Master units range (thousands).
    if (value >= 2000) {
        return Math.max(1, Math.round(value * MASTER_UNIT_TO_PX));
    }
    // Points fallback (rare).
    return Math.max(1, Math.round((value * PX_PER_INCH) / 72));
}

// ---------------------------------------------------------------------------
// Slide ordering via SlideListWithText (RT_SlideListWithText 4080)
//
// Document container -> SlideListWithText -> SlidePersistAtom (1011) entries
// give us the presentation-order persist refs. We match them against the
// `recInstance` field of each RT_Slide container (which encodes the slide's
// persist ID) to reorder the on-disk slide list into presentation order.
//
// Note: real PPT files also carry RT_PersistDirectoryAtom (6002) at the
// document level, which is the spec-correct ordering source. Decoding it
// requires parsing the UserEditAtom chain at the end of the stream and
// then dereferencing each persist ID against the directory entries — that
// is out of scope for issue #78 Tier 1. The SlideListWithText approach
// is the same heuristic the VSCode reference uses and works for every
// deck that hasn't been bulk-edited dozens of times.
// ---------------------------------------------------------------------------

export function extractOrderedSlidePersistRefs(records: PptRecord[]): number[] {
    const refs: number[] = [];
    const visit = (list: PptRecord[]): void => {
        for (const record of list) {
            if (record.recType === RT_DOCUMENT && record.children) {
                for (const child of record.children) {
                    if (
                        child.recType === RT_SLIDE_LIST_WITH_TEXT
                        && child.children
                        && child.children.length > 0
                    ) {
                        for (const entry of child.children) {
                            if (
                                entry.recType === RT_SLIDE_PERSIST_ATOM
                                && entry.payload.length >= 4
                            ) {
                                refs.push(readUInt32LE(entry.payload, 0));
                            }
                        }
                    }
                }
            }
            if (record.children && record.children.length > 0) {
                visit(record.children);
            }
        }
    };
    visit(records);
    return refs.filter((value) => Number.isFinite(value) && value > 0);
}

/**
 * Reorder the on-disk slide list using the SlideListWithText persist refs.
 * When the persist refs map cleanly to slide `recInstance` values we use
 * presentation order; otherwise we fall back to on-disk order so the
 * viewer never blanks out.
 */
function reorderSlidesByPersistRefs(
    slides: PptRecord[],
    persistRefs: number[]
): PptRecord[] {
    if (persistRefs.length === 0) return slides;
    const byRef = new Map<number, PptRecord>();
    for (const slide of slides) {
        if (!byRef.has(slide.recInstance)) {
            byRef.set(slide.recInstance, slide);
        }
    }
    const ordered: PptRecord[] = [];
    const seen = new Set<PptRecord>();
    for (const ref of persistRefs) {
        const slide = byRef.get(ref);
        if (slide && !seen.has(slide)) {
            seen.add(slide);
            ordered.push(slide);
        }
    }
    return ordered.length > 0 ? ordered : slides;
}

function readColorStruct(payload: Uint8Array, offset: number): string | undefined {
    if (offset < 0 || offset + 4 > payload.length) return undefined;
    const toHex = (value: number): string => value.toString(16).padStart(2, '0');
    return `#${toHex(payload[offset])}${toHex(payload[offset + 1])}${toHex(payload[offset + 2])}`;
}

/** Read a slide/master ColorSchemeAtom. The first color slot is the slide background. */
export function extractLegacyBackgroundColor(record: PptRecord): string | undefined {
    const atom = (record.children ?? []).find(
        (child) => child.recType === RT_COLOR_SCHEME_ATOM && child.payload.length >= 32
    );
    return atom ? readColorStruct(atom.payload, 0) : undefined;
}

/** Find the document/master default background used when a slide has no override. */
export function extractLegacyDocumentBackgroundColor(records: PptRecord[]): string | undefined {
    for (const record of records) {
        if (record.recType === RT_DOCUMENT || record.recType === 1016) {
            const color = extractLegacyBackgroundColor(record);
            if (color) return color;
        }
        if (record.children) {
            const nested = extractLegacyDocumentBackgroundColor(record.children);
            if (nested) return nested;
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// OfficeArt SpContainer geometry
//
// A slide's drawing tree lives inside an OfficeArt DgContainer; each shape
// is an SpContainer (0xF004). Inside the SpContainer we look for:
//   - 0xF010 ClientAnchor — rect2D bounds (8 or 16 bytes)
//   - 0xF00F Anchor / ChildAnchor — rect2D bounds (16 bytes)
//   - 0xF00D ClientTextbox — wraps the text atoms for this shape
//   - 0xF00B OPT property table — picture references (opid 0x0104 / 0x0186)
// ---------------------------------------------------------------------------

/** Decode a 16-byte int32 rect (left, top, right, bottom) into bounds. */
export function readRectBounds32(payload: Uint8Array): PptShapeBounds | undefined {
    if (payload.length < 16) return undefined;
    const left = readInt32LE(payload, 0);
    const top = readInt32LE(payload, 4);
    const right = readInt32LE(payload, 8);
    const bottom = readInt32LE(payload, 12);
    return makeBounds(left, top, right, bottom);
}

/** Decode an 8-byte int16 rect. The VSCode reference uses (top, left,
 * right, bottom) for the ChildAnchor 8-byte variant; we mirror that. */
export function readRectBounds16(payload: Uint8Array): PptShapeBounds | undefined {
    if (payload.length < 8) return undefined;
    // The 8-byte ChildAnchor canonical order in MS-ODRAW is (top, left,
    // right, bottom) for the ChildAnchor variant. For ClientAnchor it is
    // (top, left, right, bottom) for the int16 form too. Use that order.
    const top = readInt16LE(payload, 0);
    const left = readInt16LE(payload, 2);
    const right = readInt16LE(payload, 4);
    const bottom = readInt16LE(payload, 6);
    return makeBounds(left, top, right, bottom);
}

function makeBounds(left: number, top: number, right: number, bottom: number): PptShapeBounds | undefined {
    const width = right - left;
    const height = bottom - top;
    if (!Number.isFinite(left) || !Number.isFinite(top) || width <= 0 || height <= 0) {
        return undefined;
    }
    return { x: left, y: top, width, height };
}

/** Pull bounds out of an SpContainer (0xF004). Returns undefined when no
 * anchor record is present. */
export function extractShapeBoundsFromSpContainer(
    spContainer: PptRecord
): PptShapeBounds | undefined {
    for (const child of spContainer.children ?? []) {
        // 0xF00F Anchor (rect2D int32)
        if (child.recType === OFFICE_ART_ANCHOR_RECT && child.payload.length >= 16) {
            const bounds = readRectBounds32(child.payload);
            if (bounds) return bounds;
        }
        // 0xF010 ClientAnchor / ChildAnchor (either int16 or int32 form)
        if (child.recType === OFFICE_ART_CLIENT_ANCHOR) {
            if (child.payload.length >= 16) {
                const bounds = readRectBounds32(child.payload);
                if (bounds) return bounds;
            }
            if (child.payload.length >= 8) {
                const bounds = readRectBounds16(child.payload);
                if (bounds) return bounds;
            }
        }
    }
    return undefined;
}

/** Pull the picture reference (BLIP id) from an SpContainer's OPT
 * (0xF00B) property table. The picture id lives in property 0x0104
 * (pib) or 0x0186 (fillBlip); the property is a "blip id" complex
 * property when bit 0x4000 is set. */
export function extractShapeImageRefFromSpContainer(
    spContainer: PptRecord
): number | undefined {
    for (const child of spContainer.children ?? []) {
        if (child.recType !== OFFICE_ART_OPT || child.payload.length < 6) continue;
        const propertyCount = child.recInstance;
        for (let index = 0; index < propertyCount; index++) {
            const offset = index * 6;
            if (offset + 6 > child.payload.length) break;
            const rawOpid = readUInt16LE(child.payload, offset);
            const opid = rawOpid & 0x3fff;
            const isComplex = (rawOpid & 0x8000) !== 0;
            const isBlipId = (rawOpid & 0x4000) !== 0;
            if (isComplex || !isBlipId) continue;
            if (opid === 0x0104 || opid === 0x0186) {
                const value = readUInt32LE(child.payload, offset + 2);
                if (value > 0) return value;
            }
        }
    }
    return undefined;
}

/** Resolve the placeholder kind for a shape by inspecting the
 * TextHeaderAtom (3999) inside its ClientTextbox subtree. textType
 * values: 0=title, 1=body, 2=notes, 3=other, 4=centre title, 5=centre
 * body, 6=half title, 7=quarter body. We collapse to a coarse
 * 'title' | 'body' | 'other' tri-state. */
function pickPlaceholderKind(spContainer: PptRecord): 'title' | 'body' | 'other' | undefined {
    let kind: 'title' | 'body' | 'other' | undefined;
    const visit = (record: PptRecord): void => {
        if (record.recType === RT_TEXT_HEADER_ATOM && record.payload.length >= 4) {
            const textType = readUInt32LE(record.payload, 0);
            if (textType === 0 || textType === 4 || textType === 6) {
                kind = 'title';
            } else if (textType === 1 || textType === 5 || textType === 7) {
                kind = 'body';
            } else {
                kind = 'other';
            }
        }
        if (record.children) {
            for (const c of record.children) {
                if (!kind) visit(c);
            }
        }
    };
    if (spContainer.children) {
        for (const c of spContainer.children) {
            if (!kind) visit(c);
        }
    }
    return kind;
}

/**
 * Walk the SpContainer descendants of a slide and build a list of
 * `PptSlideElement` entries — one text element per shape with text and
 * one picture element per shape with a BLIP reference. Text atoms that
 * live outside an SpContainer (orphans) are surfaced with `bounds:
 * undefined` so the renderer can fall back to a default position.
 */
export function extractSlideElements(
    slide: PptRecord,
    pictureIds: Set<number>
): PptSlideElement[] {
    const elements: PptSlideElement[] = [];
    const orphanTexts: string[] = [];
    const seenShapeTexts = new Set<PptRecord>();

    const visit = (list: PptRecord[]): void => {
        for (const record of list) {
            if (record.recType === OFFICE_ART_SP_CONTAINER && record.children) {
                const bounds = extractShapeBoundsFromSpContainer(record);
                const placeholderKind = pickPlaceholderKind(record);
                const shapeTexts: string[] = [];
                collectShapeTexts(record, shapeTexts, seenShapeTexts);
                for (const text of shapeTexts) {
                    elements.push({
                        kind: 'text',
                        bounds,
                        text,
                        placeholderKind
                    });
                }
                const imageRef = extractShapeImageRefFromSpContainer(record);
                if (imageRef !== undefined && pictureIds.has(imageRef)) {
                    elements.push({
                        kind: 'picture',
                        bounds,
                        pictureId: imageRef
                    });
                }
                // Recurse into nested containers (group shapes etc) so
                // we don't miss inner SpContainers.
                visit(record.children);
                continue;
            }
            if (record.children && record.children.length > 0) {
                visit(record.children);
            }
        }
    };

    // First pass: shape-attributed text + pictures.
    visit(slide.children ?? []);

    // Second pass: any text atom not yet attributed to a shape. These
    // come from slide-level outlines or master-text atoms slipped into
    // the slide container without an OfficeArt wrapper.
    collectOrphanTexts(slide, seenShapeTexts, orphanTexts);
    for (const text of orphanTexts) {
        elements.push({ kind: 'text', text });
    }

    return elements;
}

function collectShapeTexts(
    spContainer: PptRecord,
    out: string[],
    seenRecords: Set<PptRecord>
): void {
    const visit = (record: PptRecord): void => {
        const decoded = decodeTextAtom(record);
        if (decoded !== null) {
            seenRecords.add(record);
            const cleaned = decoded.replace(/\r\n?/g, '\n').trim();
            if (cleaned.length > 0) out.push(cleaned);
        }
        if (record.children) {
            // Don't descend into nested SpContainers — those are
            // separate shapes and get visited at the outer level.
            for (const c of record.children) {
                if (c.recType === OFFICE_ART_SP_CONTAINER) continue;
                visit(c);
            }
        }
    };
    if (spContainer.children) {
        for (const c of spContainer.children) {
            if (c.recType === OFFICE_ART_SP_CONTAINER) continue;
            visit(c);
        }
    }
}

function collectOrphanTexts(
    slide: PptRecord,
    seenRecords: Set<PptRecord>,
    out: string[]
): void {
    const visit = (record: PptRecord): void => {
        const decoded = decodeTextAtom(record);
        if (decoded !== null && !seenRecords.has(record)) {
            const cleaned = decoded.replace(/\r\n?/g, '\n').trim();
            if (cleaned.length > 0) out.push(cleaned);
        }
        if (record.children) {
            for (const c of record.children) {
                visit(c);
            }
        }
    };
    if (slide.children) {
        for (const c of slide.children) {
            visit(c);
        }
    }
}

// ---------------------------------------------------------------------------
// Pictures stream
//
// The `Pictures` stream is a concatenation of OfficeArt BLIP records, each
// with an 8-byte header (verInst + type + length) followed by a small
// BLIP-specific preamble (UID + metadata) and then the raw image bytes
// (PNG / JPEG / DIB). The BSE table inside the OfficeArt DgContainer of
// the Document refers to each BLIP by its byte offset.
//
// For Tier 1 we take a simpler route that the VSCode reference also uses
// as its primary path: scan the stream for PNG / JPEG magic bytes and
// extract whole images by walking their format-specific framing. Each
// found image gets the next sequential blipId (1-based), matching the
// MS-ODRAW convention of "BSE entry 1 -> blip 1".
//
// DIB (BMP) support is best-effort: we detect the 'BM' magic and read
// the DIB length from the file header.
// ---------------------------------------------------------------------------

export function extractPicturesFromStream(stream: Uint8Array | null): Map<number, PptPictureAsset> {
    const out = new Map<number, PptPictureAsset>();
    if (!stream || stream.length === 0) return out;
    let nextId = 1;

    // Scan PNG signatures (89 50 4E 47 0D 0A 1A 0A).
    for (let i = 0; i + 8 <= stream.length; i++) {
        if (
            stream[i] === 0x89
            && stream[i + 1] === 0x50
            && stream[i + 2] === 0x4e
            && stream[i + 3] === 0x47
            && stream[i + 4] === 0x0d
            && stream[i + 5] === 0x0a
            && stream[i + 6] === 0x1a
            && stream[i + 7] === 0x0a
        ) {
            const end = findPngEnd(stream, i);
            if (end > i) {
                out.set(nextId++, {
                    id: nextId - 1,
                    mime: 'image/png',
                    bytes: stream.slice(i, end)
                });
                i = end - 1;
            }
        }
    }

    // Scan JPEG signatures (FF D8 FF). Use FFD8FF rather than FFD8 alone
    // to avoid false positives from byte-stuffed entropy data.
    for (let i = 0; i + 3 <= stream.length; i++) {
        if (stream[i] === 0xff && stream[i + 1] === 0xd8 && stream[i + 2] === 0xff) {
            const end = findJpegEnd(stream, i);
            if (end > i) {
                out.set(nextId++, {
                    id: nextId - 1,
                    mime: 'image/jpeg',
                    bytes: stream.slice(i, end)
                });
                i = end - 1;
            }
        }
    }

    // Scan DIB / BMP signatures ('BM').
    for (let i = 0; i + 6 <= stream.length; i++) {
        if (stream[i] === 0x42 && stream[i + 1] === 0x4d) {
            const declared = readUInt32LE(stream, i + 2);
            if (declared >= 14 && i + declared <= stream.length) {
                out.set(nextId++, {
                    id: nextId - 1,
                    mime: 'image/bmp',
                    bytes: stream.slice(i, i + declared)
                });
                i = i + declared - 1;
            }
        }
    }

    return out;
}

function findPngEnd(buf: Uint8Array, start: number): number {
    // PNG: 8-byte signature + a series of chunks. Each chunk is
    // u32 length BE, 4 bytes type, length bytes data, u32 CRC BE.
    let off = start + 8;
    const view = asDataView(buf);
    while (off + 12 <= buf.length) {
        const len = view.getUint32(off, false);
        const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
        off += 12 + len;
        if (off > buf.length) return -1;
        if (type === 'IEND') return off;
    }
    return -1;
}

function findJpegEnd(buf: Uint8Array, start: number): number {
    const view = asDataView(buf);
    let pos = start + 2; // skip SOI (FFD8)
    while (pos < buf.length - 1) {
        if (buf[pos] !== 0xff) {
            pos++;
            continue;
        }
        const marker = buf[pos + 1];
        // Byte-stuffed 0xFF00 or padding 0xFFFF — skip.
        if (marker === 0x00 || marker === 0xff) {
            pos++;
            continue;
        }
        // EOI
        if (marker === 0xd9) return pos + 2;
        // SOS (FFDA) - entropy-coded data follows; scan for next marker.
        if (marker === 0xda) {
            if (pos + 3 >= buf.length) return -1;
            const sosLen = view.getUint16(pos + 2, false);
            let scan = pos + 2 + sosLen;
            while (scan < buf.length - 1) {
                if (buf[scan] === 0xff) {
                    const m = buf[scan + 1];
                    if (m === 0xd9) return scan + 2;
                    if (m === 0x00) {
                        scan += 2;
                        continue;
                    }
                    if (m >= 0xd0 && m <= 0xd7) {
                        scan += 2;
                        continue;
                    }
                    pos = scan;
                    break;
                }
                scan++;
            }
            if (scan >= buf.length - 1) return -1;
            continue;
        }
        // Variable-length segment.
        if (pos + 3 >= buf.length) return -1;
        const segLen = view.getUint16(pos + 2, false);
        if (segLen < 2) return -1;
        pos += 2 + segLen;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a `.ppt` (PowerPoint 97-2003 binary) buffer into an in-memory
 * slide model. Throws `Error` on missing / invalid CFB structure or a
 * missing `PowerPoint Document` stream.
 */
export function parsePptBuffer(input: ArrayBuffer | Uint8Array): PptParseResult {
    const cfb = parseCfb(input);
    const docStream = cfb.getStream('PowerPoint Document');
    if (!docStream) {
        throw new Error('Invalid .ppt file: missing "PowerPoint Document" stream.');
    }

    const records = parseRecords(docStream, 0, docStream.length);
    const metrics = extractPresentationMetrics(records);

    // Best-effort picture extraction. A failure here must not break the
    // text-only fallback path, so we wrap it defensively.
    let picturesById: Map<number, PptPictureAsset>;
    try {
        const picturesStream = cfb.getStream('Pictures');
        picturesById = extractPicturesFromStream(picturesStream);
    } catch {
        picturesById = new Map();
    }

    const slideRecordsRaw = collectSlideRecords(records);
    const documentBackgroundColor = extractLegacyDocumentBackgroundColor(records);

    if (slideRecordsRaw.length === 0) {
        // Recover-mode: surface a single virtual slide containing every
        // decoded text atom from the document stream. This keeps the
        // viewer useful even when the slide containers are missing or
        // the document was produced by an unusual exporter.
        const fallbackTexts = extractAllTexts(records);
        if (fallbackTexts.length === 0) {
            return { slides: [], totalSlides: 0, metrics, pictures: picturesById };
        }
        const slide: PptSlideModel = {
            slideNumber: 1,
            backgroundColor: documentBackgroundColor,
            texts: fallbackTexts.slice(0, 200)
        };
        return { slides: [slide], totalSlides: 1, metrics, pictures: picturesById };
    }

    // Reorder via SlideListWithText when available, otherwise keep
    // on-disk order. See `extractOrderedSlidePersistRefs` for the
    // limitation of this heuristic.
    const persistRefs = extractOrderedSlidePersistRefs(records);
    const slideRecords = reorderSlidesByPersistRefs(slideRecordsRaw, persistRefs);

    const pictureIds = new Set(picturesById.keys());
    const slides: PptSlideModel[] = slideRecords.map((record, index) => {
        const texts = extractTextsFromSlide(record);
        let elements: PptSlideElement[] | undefined;
        let pictures: PptPictureAsset[] | undefined;
        try {
            const built = extractSlideElements(record, pictureIds);
            if (built.length > 0) {
                elements = built;
                // Collect the picture assets referenced by this slide so
                // the renderer doesn't have to thread a document-wide
                // map through every call site.
                const usedIds = new Set<number>();
                for (const el of built) {
                    if (el.kind === 'picture') usedIds.add(el.pictureId);
                }
                if (usedIds.size > 0) {
                    pictures = [];
                    for (const id of usedIds) {
                        const asset = picturesById.get(id);
                        if (asset) pictures.push(asset);
                    }
                }
            }
        } catch {
            // OfficeArt walk failed for this slide — keep text-only.
            elements = undefined;
            pictures = undefined;
        }
        const slide: PptSlideModel = {
            slideNumber: index + 1,
            backgroundColor: extractLegacyBackgroundColor(record) || documentBackgroundColor,
            texts
        };
        if (elements && elements.length > 0) slide.elements = elements;
        if (pictures && pictures.length > 0) slide.pictures = pictures;
        return slide;
    });

    return {
        slides,
        totalSlides: slides.length,
        metrics,
        pictures: picturesById
    };
}

// ---------------------------------------------------------------------------
// Issue #79 — Legacy `.ppt` loose-text recovery.
//
// When `parsePptBuffer` returns zero slides, or every slide came back with
// empty `texts[]` and no `elements[]`, the viewer asks this helper to
// scan the raw `PowerPoint Document` CFB stream for *any* recognisable
// text payloads. Internally it reuses the parser tree that
// `parsePptBuffer` already produces (so we benefit from the same CP949 /
// Shift-JIS heuristics that the primary path uses), but it disregards
// slide-container boundaries — we collapse the entire document into one
// virtual slide of text so the existing text-only legacy renderer can
// display something.
//
// Returns a 2-D array: outer = slides (always exactly one in the current
// implementation, kept as an array so the signature stays forward-compatible
// for a future "one-virtual-slide-per-RT_Document-cluster" refinement).
// Inner = the text strings the loose scan recovered, deduplicated.
//
// Guarantees:
//   - Never throws. Any CFB / record / decode error returns `[]`.
//   - Empty buffer / non-CFB buffer returns `[]`.
//   - Output is suitable for direct splice into `PptSlideModel.texts`.
// ---------------------------------------------------------------------------

export function extractLooseTextFromCfb(
    input: ArrayBuffer | Uint8Array
): string[][] {
    if (!input) return [];
    try {
        const bytes = toUint8(input);
        if (!isCfbMagic(bytes)) return [];
        const cfb = parseCfb(bytes);
        const docStream = cfb.getStream('PowerPoint Document');
        if (!docStream || docStream.length === 0) return [];
        const records = parseRecords(docStream, 0, docStream.length);
        if (records.length === 0) return [];
        const recovered = extractAllTexts(records);
        if (recovered.length === 0) return [];
        // Cap at 200 entries to match the in-band recovery branch in
        // `parsePptBuffer` (avoids master-text runaways on huge decks).
        return [recovered.slice(0, 200)];
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Class wrapper - matches the VSCode reference's `PptBinaryParser.parse`
// shape so callers that want a familiar API can import either the
// functional helpers or the static methods. Both delegate to the same
// implementation; the class form is purely ergonomic.
// ---------------------------------------------------------------------------

export class PptBinaryParser {
    public static parseBuffer(input: ArrayBuffer | Uint8Array): PptParseResult {
        return parsePptBuffer(input);
    }

    public static async parseFile(file: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<PptParseResult> {
        const buffer = await file.arrayBuffer();
        return parsePptBuffer(buffer);
    }
}
