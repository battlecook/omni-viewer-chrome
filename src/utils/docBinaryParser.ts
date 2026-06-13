// Browser-only legacy .doc (Word 97-2003) parser for omni-viewer-chrome
// (issue #44).
//
// This module is a *minimum* port of the VSCode build's
// `docBinaryParser.ts` (~187 KB / ~4900 LOC). The VSCode parser is a
// deep implementation that decodes paragraph styles, character runs,
// tables, embedded workbooks/charts, OfficeArt drawings, headers/
// footers, section layout, etc. The Chrome build only needs the
// smallest subset that turns the raw byte stream into readable
// paragraphs:
//
//   1. CFB (Compound File Binary) container parsing - locate the
//      WordDocument stream and the active table stream
//      (1Table / 0Table) inside the OLE container.
//   2. FIB (File Information Block) - read the bits that point at the
//      piece-table and the table stream selector.
//   3. CLX -> piece table walker - turn (cp, fc, compressed?) tuples
//      into decoded text fragments.
//   4. Decode each fragment as either UTF-16LE (Word "wide" pieces) or
//      a single-byte ANSI code page (Windows-1252 / EUC-KR/CP949 /
//      Shift-JIS) via the browser's `TextDecoder`. The best-scoring
//      decode wins.
//   5. Render plain HTML - one `<p>` per paragraph; no styling,
//      tables, images, or headers/footers in this build.
//
// Deferred (intentionally not ported - these live in the VSCode source
// and are tracked as follow-ups beyond #44):
//   - Tables (TDef parsing, cell merges, borders).
//   - Inline / floating images.
//   - Embedded workbooks + charts (ObjectPool, Package streams).
//   - Headers / footers (per-section stories from PlcfHdd).
//   - Per-run character styles (bold/italic/font/colour) and
//     per-paragraph style runs (alignment, indents, list levels).
//   - Section layout (page size, margins, columns).
//
// Browser constraints:
//   - No `Buffer`. We work over `Uint8Array` + `DataView`.
//   - No `fs`. Caller supplies an `ArrayBuffer` from `File.arrayBuffer()`.
//   - No npm deps. Just `TextDecoder` for UTF-16 and CP949/Shift-JIS/etc.
//
// Style note: every literal control byte in the regexes below is written
// with an explicit `\xNN` / `\uNNNN` escape so that the source file
// survives copy-paste through editors and pipes that strip raw
// non-printable bytes.

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

// FAT sentinels appear as -2 (ENDOFCHAIN = 0xFFFFFFFE) and -1
// (FREESECT = 0xFFFFFFFF) when read via DataView.getInt32. Compare
// against the signed form so we never need a `>>> 0` round-trip.
const FAT_ENDOFCHAIN = -2;
const FAT_FREESECT = -1;

// CP949 is Korean (a Microsoft superset of EUC-KR). The browser
// `TextDecoder` ships with `euc-kr` which decodes the CP949 byte range
// correctly for the documents we care about.
const ANSI_DECODER_LABELS = ['windows-1252', 'euc-kr', 'shift_jis'] as const;
type AnsiLabel = (typeof ANSI_DECODER_LABELS)[number];

interface CfbEntry {
    name: string;
    type: number;
    startSector: number;
    size: number;
}

export interface CfbReader {
    getStream(name: string): Uint8Array | null;
    listStreams(): Array<{ name: string; size: number }>;
}

export interface FibInfo {
    nFib: number;
    tableStreamName: '0Table' | '1Table';
    ccpText: number;
    ccpFtn: number;
    ccpHdd: number;
    fcClx: number;
    lcbClx: number;
}

interface DecodedPieceSegment {
    text: string;
    cpStart: number;
    bytesPerChar: 1 | 2;
}

interface PieceTableCandidate {
    text: string;
    score: number;
    decodedSegments: DecodedPieceSegment[];
}

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

function readInt32LE(buf: Uint8Array, offset: number): number {
    return asDataView(buf).getInt32(offset, true);
}

function subarray(buf: Uint8Array, start: number, end?: number): Uint8Array {
    return buf.subarray(start, end ?? buf.length);
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
    // `TextDecoder('utf-16le')` is required by the spec and shipped in
    // every Chromium release.
    return new TextDecoder('utf-16le').decode(buf);
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

// ---------------------------------------------------------------------------
// CFB (Compound File Binary) parser
//
// MS-CFB describes an OLE2 container with:
//   - 512-byte (or 4096-byte) sectors
//   - a sector-allocation table (FAT) reached via the DIFAT
//   - a directory stream of 128-byte entries
//   - a mini-stream + mini-FAT for streams smaller than `miniCutoff`
//
// We only need the read side: build the FAT, follow chains, decode the
// directory, and expose `getStream(name)` for the WordDocument /
// 1Table / 0Table streams.
// ---------------------------------------------------------------------------

export function parseCfb(input: ArrayBuffer | Uint8Array): CfbReader {
    const file = toUint8(input);
    if (file.length < 512) {
        throw new Error('Invalid CFB file: too small.');
    }
    for (let i = 0; i < 8; i++) {
        if (file[i] !== CFB_SIGNATURE[i]) {
            throw new Error('Invalid CFB signature.');
        }
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

    // ---- DIFAT ----------------------------------------------------------
    const difat: number[] = [];
    for (let i = 0; i < 109; i++) {
        const sid = readInt32LE(file, 76 + i * 4);
        if (sid !== -1) {
            difat.push(sid);
        }
    }
    let nextDifat = firstDifatSector;
    for (
        let i = 0;
        i < numDifatSectors && nextDifat !== FAT_ENDOFCHAIN && nextDifat !== -1;
        i++
    ) {
        const sector = readSector(nextDifat);
        if (sector.length === 0) break;
        const entryCount = sectorSize / 4 - 1;
        for (let j = 0; j < entryCount; j++) {
            const sid = readInt32LE(sector, j * 4);
            if (sid !== -1) {
                difat.push(sid);
            }
        }
        nextDifat = readInt32LE(sector, sectorSize - 4);
    }

    // ---- FAT ------------------------------------------------------------
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

    // ---- Directory ------------------------------------------------------
    const dirStream = readChain(firstDirSector);
    const entries: CfbEntry[] = [];
    for (let offset = 0; offset + 128 <= dirStream.length; offset += 128) {
        const nameLength = readUInt16LE(dirStream, offset + 64);
        const nameBytes = dirStream.subarray(
            offset,
            offset + Math.max(0, nameLength - 2)
        );
        // Strip embedded NULs from the UTF-16 directory name.
        const name = decodeUtf16Le(nameBytes).replace(/ /g, '');
        const type = dirStream[offset + 66];
        const startSector = readInt32LE(dirStream, offset + 116);
        const sizeLow = readUInt32LE(dirStream, offset + 120);
        const sizeHigh = readUInt32LE(dirStream, offset + 124);
        // .doc files almost never exceed 4 GB; if the high word is
        // non-zero the file is corrupt or extremely unusual - treat the
        // low 32 bits as the size and let downstream bounds checks
        // protect us.
        const size = sizeHigh > 0 ? sizeLow : sizeLow;
        entries.push({ name, type, startSector, size });
    }

    // ---- Mini stream ----------------------------------------------------
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
            if (entry.size < miniCutoff) {
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
// FIB (File Information Block)
//
// We only need the bits that tell us:
//   - which table stream is active (1Table vs 0Table - bit 9 of the
//     `flags` field at offset 10),
//   - how many CPs of body / footnote / header text exist,
//   - where the CLX (piece table container) lives in the table stream.
//
// We *don't* need the per-glyph style runs (CHPX/PAPX) or section
// boundaries (PLCfSed) for the minimum viable text path; those are
// tracked as deferred features above.
// ---------------------------------------------------------------------------

export function parseFib(wordStream: Uint8Array): FibInfo {
    if (wordStream.length < 32) {
        throw new Error('Invalid WordDocument stream: missing FIB base.');
    }

    const nFib = readUInt16LE(wordStream, 2);
    const flags = readUInt16LE(wordStream, 10);
    const tableStreamName = ((flags >> 9) & 0x0001) === 1 ? '1Table' : '0Table';

    let offset = 32;
    const csw = readUInt16LE(wordStream, offset);
    offset += 2 + csw * 2;

    const cslw = readUInt16LE(wordStream, offset);
    offset += 2;
    const fibRgLwOffset = offset;
    const fibRgLwLength = cslw * 4;
    const ccpText =
        fibRgLwLength >= 16 && fibRgLwOffset + 16 <= wordStream.length
            ? readUInt32LE(wordStream, fibRgLwOffset + 12)
            : 0;
    const ccpFtn =
        fibRgLwLength >= 20 && fibRgLwOffset + 20 <= wordStream.length
            ? readUInt32LE(wordStream, fibRgLwOffset + 16)
            : 0;
    const ccpHdd =
        fibRgLwLength >= 24 && fibRgLwOffset + 24 <= wordStream.length
            ? readUInt32LE(wordStream, fibRgLwOffset + 20)
            : 0;
    offset += fibRgLwLength;

    const cbRgFcLcb = readUInt16LE(wordStream, offset);
    offset += 2;
    const fibRgFcLcbOffset = offset;

    // FibRgFcLcb is a flat array of (fc, lcb) pairs. The CLX pair lives
    // at index 33 in the FIB97 spec, which is what every .doc we care
    // about (Word 97 / 2000 / 2002 / 2003) uses.
    const readPair = (pairIndex: number): { fc: number; lcb: number } => {
        const pairOffset = fibRgFcLcbOffset + pairIndex * 8;
        if (pairIndex >= cbRgFcLcb || pairOffset + 8 > wordStream.length) {
            return { fc: 0, lcb: 0 };
        }
        return {
            fc: readUInt32LE(wordStream, pairOffset),
            lcb: readUInt32LE(wordStream, pairOffset + 4)
        };
    };

    const clx = readPair(33);

    return {
        nFib,
        tableStreamName,
        ccpText,
        ccpFtn,
        ccpHdd,
        fcClx: clx.fc,
        lcbClx: clx.lcb
    };
}

// ---------------------------------------------------------------------------
// Piece table walker
//
// The CLX container has zero or more `Prc` (0x01-tagged grpprl) prefixes
// followed by exactly one `Pcdt` (0x02-tagged piece table). The piece
// table is laid out as:
//   [ cp[0] .. cp[n] ]   (n+1 little-endian uint32 character positions)
//   [ pcd[0] .. pcd[n-1] ]   (n PCD records, 8 bytes each)
//
// Each PCD points at a byte range inside the WordDocument stream. The
// high bit of the FC field (0x40000000) flags the piece as `compressed`
// - meaning each character is one ANSI byte. Otherwise each character
// is two UTF-16LE bytes; for compressed pieces the on-disk address is
// the FC with the compression flag cleared and shifted right by 1.
//
// We try every reasonable combination of:
//   - PCD offset (some files store the FC at byte 2 of the PCD - the
//     VSCode reference uses both `[2, 0]` orderings),
//   - ANSI decoder for compressed pieces (we have to guess between
//     CP1252 / EUC-KR / Shift-JIS - score-based selection).
// ---------------------------------------------------------------------------

export function extractFromClx(
    wordStream: Uint8Array,
    tableStream: Uint8Array,
    fib: FibInfo
): PieceTableCandidate | null {
    if (
        fib.lcbClx <= 0 ||
        fib.fcClx < 0 ||
        fib.fcClx + fib.lcbClx > tableStream.length
    ) {
        return null;
    }

    const clx = subarray(tableStream, fib.fcClx, fib.fcClx + fib.lcbClx);
    let offset = 0;

    // Skip Prc (0x01) prefixes.
    while (offset < clx.length && clx[offset] === 0x01) {
        if (offset + 3 > clx.length) return null;
        const cbGrpprl = readUInt16LE(clx, offset + 1);
        offset += 3 + cbGrpprl;
    }

    if (offset + 5 > clx.length || clx[offset] !== 0x02) return null;
    const lcb = readUInt32LE(clx, offset + 1);
    if (lcb < 16 || offset + 5 + lcb > clx.length) return null;

    const plcPcd = subarray(clx, offset + 5, offset + 5 + lcb);
    const pieceCount = (lcb - 4) / 12;
    if (pieceCount <= 0 || !Number.isInteger(pieceCount)) return null;

    return (
        decodePieceTable(wordStream, plcPcd, pieceCount, 2) ??
        decodePieceTable(wordStream, plcPcd, pieceCount, 0)
    );
}

export function extractFromPieceTable(
    wordStream: Uint8Array,
    tableStream: Uint8Array
): PieceTableCandidate | null {
    let best: PieceTableCandidate | null = null;
    for (let offset = 0; offset + 5 < tableStream.length; offset++) {
        if (tableStream[offset] !== 0x02) continue;
        const lcb = readUInt32LE(tableStream, offset + 1);
        if (lcb < 16 || offset + 5 + lcb > tableStream.length) continue;
        if ((lcb - 4) % 12 !== 0) continue;
        const pieceCount = (lcb - 4) / 12;
        if (pieceCount <= 0 || pieceCount > 200000) continue;

        const plcPcd = subarray(tableStream, offset + 5, offset + 5 + lcb);
        for (const fcOffset of [2, 0]) {
            const candidate = decodePieceTable(
                wordStream,
                plcPcd,
                pieceCount,
                fcOffset
            );
            if (!candidate) continue;
            if (!best || candidate.score > best.score) best = candidate;
        }
    }
    return best;
}

function decodePieceTable(
    wordStream: Uint8Array,
    plcPcd: Uint8Array,
    pieceCount: number,
    fcOffset: number
): PieceTableCandidate | null {
    const cpCount = pieceCount + 1;
    const cpByteLength = cpCount * 4;
    if (cpByteLength >= plcPcd.length) return null;

    const cps: number[] = [];
    for (let i = 0; i < cpCount; i++) {
        cps.push(readUInt32LE(plcPcd, i * 4));
    }
    if (!isValidCpSequence(cps)) return null;

    const decodedByAnsi = new Map<AnsiLabel, string[]>();
    const segmentsByAnsi = new Map<AnsiLabel, DecodedPieceSegment[]>();
    for (const label of ANSI_DECODER_LABELS) {
        decodedByAnsi.set(label, []);
        segmentsByAnsi.set(label, []);
    }

    for (let i = 0; i < pieceCount; i++) {
        const charCount = cps[i + 1] - cps[i];
        if (charCount <= 0) continue;

        const pcdOffset = cpByteLength + i * 8;
        if (pcdOffset + fcOffset + 4 > plcPcd.length) return null;

        const fcRaw = readUInt32LE(plcPcd, pcdOffset + fcOffset);
        const compressed = (fcRaw & 0x40000000) !== 0;
        const byteOffset = compressed
            ? (fcRaw & 0x3fffffff) >>> 1
            : fcRaw & 0x3fffffff;
        const byteLength = compressed ? charCount : charCount * 2;

        if (
            byteOffset < 0 ||
            byteLength < 0 ||
            byteOffset + byteLength > wordStream.length
        ) {
            return null;
        }

        const pieceBuffer = subarray(
            wordStream,
            byteOffset,
            byteOffset + byteLength
        );
        if (compressed) {
            for (const label of ANSI_DECODER_LABELS) {
                const decoder = getAnsiDecoder(label);
                const text = decoder.decode(pieceBuffer);
                decodedByAnsi.get(label)!.push(text);
                segmentsByAnsi.get(label)!.push({
                    text,
                    cpStart: cps[i],
                    bytesPerChar: 1
                });
            }
        } else {
            const text = decodeUtf16Le(pieceBuffer);
            for (const label of ANSI_DECODER_LABELS) {
                decodedByAnsi.get(label)!.push(text);
                segmentsByAnsi.get(label)!.push({
                    text,
                    cpStart: cps[i],
                    bytesPerChar: 2
                });
            }
        }
    }

    return selectBestDecodedCandidate(
        decodedByAnsi,
        segmentsByAnsi,
        cps[0] === 0,
        pieceCount
    );
}

function isValidCpSequence(cps: number[]): boolean {
    if (cps.length < 2) return false;
    for (let i = 1; i < cps.length; i++) {
        if (cps[i] < cps[i - 1]) return false;
    }
    const totalChars = cps[cps.length - 1] - cps[0];
    return totalChars > 0 && totalChars <= 10_000_000;
}

function selectBestDecodedCandidate(
    decodedByAnsi: Map<AnsiLabel, string[]>,
    segmentsByAnsi: Map<AnsiLabel, DecodedPieceSegment[]>,
    startsAtZero: boolean,
    pieceCount: number
): PieceTableCandidate | null {
    let best: PieceTableCandidate | null = null;
    for (const label of ANSI_DECODER_LABELS) {
        const normalized = normalizeDocumentText(
            (decodedByAnsi.get(label) ?? []).join('')
        );
        if (normalized.length < 1) continue;
        const candidate: PieceTableCandidate = {
            text: normalized,
            score: scoreExtractedText(normalized, startsAtZero, pieceCount),
            decodedSegments: segmentsByAnsi.get(label) ?? []
        };
        if (!best || candidate.score > best.score) best = candidate;
    }
    return best;
}

// ---------------------------------------------------------------------------
// Text scoring + normalisation
//
// Word stores paragraph breaks as `\r` (U+000D) and table-cell
// separators as `` (BEL). We map both to `\n`, drop other
// low-ASCII control chars, and collapse multi-blank-line runs. The
// score function rewards readable letters (incl. Hangul) and penalises
// replacement glyphs, so the right ANSI decoder wins for non-Latin
// documents.
// ---------------------------------------------------------------------------

const FIELD_CODE_NOISE_PATTERN =
    /\b(?:HYPERLINK|PAGEREF|TOC|REF)\b\s+"[^"]*"\s*/gi;

// Range covering 0x01..0x06, 0x08, 0x0c, 0x0e..0x12, 0x14..0x1f - the
// "shading + picture marker + field separator" controls Word emits in
// the body stream. We map these to a single space.
const LOW_ASCII_NOISE = /[---]/g;
// BEL (0x07 = table cell mark) and VT (0x0b = line break).
const LINE_BREAK_CONTROLS = /[]/g;

export function normalizeDocumentText(raw: string): string {
    return raw
        .replace(/ /g, '')
        .replace(FIELD_CODE_NOISE_PATTERN, '')
        .replace(LOW_ASCII_NOISE, ' ')
        .replace(LINE_BREAK_CONTROLS, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ ]{2,}/g, ' ')
        .trim();
}

const READABLE_CHAR_PATTERN = /[A-Za-z0-9가-힣]/g;
const REPLACEMENT_CHAR_PATTERN = /�/g;
const HANGUL_PATTERN = /[가-힣]/g;
const SUSPICIOUS_LATIN1_PATTERN = /[Â-ÃÐ-ÑØÞã-çð-ñøþ]/g;
// Anything outside basic-Latin (0x20..0x7e), Latin-1 supplement and
// Latin Extended-A (0x00a0..0x024f), Hangul Jamo (0x3131..0x318e),
// Hangul Syllables (0xac00..0xd7a3), and standard ASCII whitespace
// (\r \n \t).
const CONTROL_LIKE_PATTERN =
    /[^ -~ -ɏㄱ-ㆎ가-힣\r\n\t]/g;

export function scoreExtractedText(
    text: string,
    startsAtZero: boolean,
    pieceCount: number
): number {
    const paragraphs = text
        .split(/\n+/)
        .map((part) => part.trim())
        .filter(Boolean);
    const readableChars = (text.match(READABLE_CHAR_PATTERN) || []).length;
    const penalty = (text.match(REPLACEMENT_CHAR_PATTERN) || []).length * 30;
    const hangulChars = (text.match(HANGUL_PATTERN) || []).length;
    const suspiciousGlyphs =
        (text.match(SUSPICIOUS_LATIN1_PATTERN) || []).length * 12;
    const controlLike = (text.match(CONTROL_LIKE_PATTERN) || []).length * 6;

    return (
        text.length +
        paragraphs.length * 120 +
        readableChars * 2 +
        hangulChars * 3 +
        (startsAtZero ? 200 : 0) +
        Math.min(pieceCount, 2000) -
        penalty -
        suspiciousGlyphs -
        controlLike
    );
}

// ---------------------------------------------------------------------------
// Document text extraction (driver)
// ---------------------------------------------------------------------------

export interface ParsedDoc {
    text: string;
    paragraphs: string[];
    /** Best-effort table stream name we picked. */
    tableStreamName: '0Table' | '1Table';
    /** Format hint for downstream: 'doc' (always for this module). */
    sourceFormat: 'doc';
}

export function parseDocBuffer(input: ArrayBuffer | Uint8Array): ParsedDoc {
    const cfb = parseCfb(input);
    const wordStream = cfb.getStream('WordDocument');
    if (!wordStream) {
        throw new Error('Invalid .doc file: missing WordDocument stream.');
    }
    const fib = parseFib(wordStream);
    const tableStream = cfb.getStream(fib.tableStreamName);
    let candidate: PieceTableCandidate | null = null;
    if (tableStream) {
        candidate = extractFromClx(wordStream, tableStream, fib);
        if (!candidate) {
            candidate = extractFromPieceTable(wordStream, tableStream);
        }
    }

    const text = candidate?.text ?? '';
    const paragraphs = splitParagraphs(text);
    return {
        text,
        paragraphs,
        tableStreamName: fib.tableStreamName,
        sourceFormat: 'doc'
    };
}

function splitParagraphs(text: string): string[] {
    if (!text) return [];
    return text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// HTML rendering
//
// One `<p>` per paragraph. We escape HTML metacharacters but otherwise
// leave the text untouched - no inline styling, no run-level decoration.
// ---------------------------------------------------------------------------

export function renderDocAsHtml(parsed: ParsedDoc): string {
    if (parsed.paragraphs.length === 0) {
        return `<div class="ov-doc-legacy-empty">No readable text content found in this .doc file.</div>`;
    }
    const body = parsed.paragraphs
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join('');
    return `<div class="ov-doc-legacy">${body}</div>`;
}

export function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Top-level convenience: ArrayBuffer -> HTML string
// ---------------------------------------------------------------------------

export function parseDocToHtml(input: ArrayBuffer | Uint8Array): string {
    const parsed = parseDocBuffer(input);
    return renderDocAsHtml(parsed);
}

// ---------------------------------------------------------------------------
// Magic-byte detection
//
// CFB containers always start with `D0 CF 11 E0 A1 B1 1A E1`. This is
// shared with .xls / .ppt / .msg, so byte-level detection alone cannot
// uniquely identify a .doc - callers should combine the magic check with
// the file extension before routing.
// ---------------------------------------------------------------------------

export function isCfbMagic(bytes: Uint8Array | ArrayBuffer): boolean {
    const buf = toUint8(bytes);
    if (buf.length < CFB_SIGNATURE.length) return false;
    for (let i = 0; i < CFB_SIGNATURE.length; i++) {
        if (buf[i] !== CFB_SIGNATURE[i]) return false;
    }
    return true;
}
