// jest-environment-jsdom@29 does not expose TextEncoder/TextDecoder as
// globals. The parser depends on `TextDecoder('utf-16le' / 'euc-kr' /
// 'shift_jis')`, so we hoist Node's util-provided implementation onto
// `globalThis` before the parser module is imported.
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof NodeTextEncoder }).TextEncoder = NodeTextEncoder;
}
if (typeof (globalThis as { TextDecoder?: unknown }).TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof NodeTextDecoder }).TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;
}

// Unit tests for the legacy .doc CFB parser (issue #44).
//
// These tests build tiny synthetic compound files in-memory and assert
// that the parser:
//   1. Recognises (and rejects) the CFB magic.
//   2. Walks the FAT / directory and exposes the WordDocument /
//      table streams.
//   3. Decodes the FIB and locates the CLX pair.
//   4. Walks a one-piece piece table and decodes both compressed
//      (single-byte ANSI) and wide (UTF-16LE) text.
//   5. Maps `\x07` (table cell mark) and `\x0d` (paragraph) controls
//      to newlines and emits one paragraph per non-empty line.
//   6. Picks the right ANSI code page for Korean / Japanese pieces.
//   7. Renders one `<p>` per paragraph with HTML escaping intact.
//
// We do *not* try to reconstruct a real Microsoft Word document --
// we just emit the smallest valid container the parser is willing to
// walk, so the test fixtures stay readable and the failures point at
// real parser bugs rather than fixture bugs.

import {
    parseCfb,
    parseFib,
    parseDocBuffer,
    parseDocToHtml,
    isCfbMagic,
    normalizeDocumentText,
    extractFromClx,
    escapeHtml
} from '../utils/docBinaryParser';

// ---------------------------------------------------------------------------
// Test fixture: minimal CFB builder
//
// The CFB structure we emit is intentionally tiny:
//   - 512-byte sectors (sector shift = 9).
//   - Layout (each sector's SID is its index in the FAT, the file
//     offset is `(sid + 1) * 512` because the CFB header lives in
//     sector "-1"):
//       sid 0 -> FAT
//       sid 1 -> directory
//       sid 2 -> WordDocument stream
//       sid 3 -> 1Table stream
//   - No mini-stream, no DIFAT chain (109 inline DIFAT entries are
//     plenty for a four-sector container).
// ---------------------------------------------------------------------------

const SECTOR_SIZE = 512;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

interface CfbBuildInput {
    wordStream: Uint8Array;
    tableStream: Uint8Array;
}

function ceilToSector(n: number): number {
    return Math.ceil(n / SECTOR_SIZE) * SECTOR_SIZE;
}

function buildMinimalCfb({ wordStream, tableStream }: CfbBuildInput): Uint8Array {
    // Layout (each sector's SID is its index in the FAT):
    //   sid 0           -> FAT
    //   sid 1           -> directory
    //   sid 2..2+W-1    -> WordDocument stream chain
    //   sid 2+W..2+W+T-1-> 1Table stream chain
    // where W = ceil(wordStream.length / 512) and T similarly.
    const wordSectorCount = Math.max(1, Math.ceil(wordStream.length / SECTOR_SIZE));
    const tableSectorCount = Math.max(1, Math.ceil(tableStream.length / SECTOR_SIZE));
    const wordStartSid = 2;
    const tableStartSid = 2 + wordSectorCount;
    const dataSectors = 2 + wordSectorCount + tableSectorCount;
    // Header sector + the data sectors above.
    const file = new Uint8Array((1 + dataSectors) * SECTOR_SIZE);
    const view = new DataView(file.buffer);

    // ---- Header --------------------------------------------------------
    file.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
    view.setUint16(24, 0x003e, true); // minor version
    view.setUint16(26, 0x0003, true); // major version
    view.setUint16(28, 0xfffe, true); // byte order (little-endian)
    view.setUint16(30, 9, true);      // sector shift (1 << 9 == 512)
    view.setUint16(32, 6, true);      // mini-sector shift (1 << 6 == 64)
    view.setUint32(40, 0, true);      // reserved
    view.setUint32(44, 1, true);      // numFatSectors
    view.setInt32(48, 1, true);       // firstDirSector (sid=1)
    view.setUint32(52, 0, true);      // transaction signature
    // miniCutoff = 0 -- force every stream through the regular FAT.
    view.setUint32(56, 0, true);
    view.setInt32(60, ENDOFCHAIN | 0, true);   // firstMiniFatSector
    view.setUint32(64, 0, true);              // numMiniFatSectors
    view.setInt32(68, ENDOFCHAIN | 0, true);  // firstDifatSector
    view.setUint32(72, 0, true);              // numDifatSectors
    // DIFAT[0] = sid 0 (the FAT lives there).
    view.setInt32(76, 0, true);
    for (let i = 1; i < 109; i++) {
        view.setInt32(76 + i * 4, -1, true); // FREESECT
    }

    // ---- FAT (sid 0) ---------------------------------------------------
    const fatOffset = SECTOR_SIZE; // header is sector "-1", sid 0 starts here.
    for (let i = 0; i < SECTOR_SIZE / 4; i++) {
        view.setInt32(fatOffset + i * 4, FREESECT | 0, true);
    }
    // sid 0 = FAT itself.
    view.setInt32(fatOffset + 0 * 4, 0xfffffffd | 0, true);
    // sid 1 = directory (single sector).
    view.setInt32(fatOffset + 1 * 4, ENDOFCHAIN | 0, true);
    // WordDocument chain: sid wordStartSid .. wordStartSid + wordSectorCount - 1.
    for (let i = 0; i < wordSectorCount; i++) {
        const sid = wordStartSid + i;
        const next = i + 1 < wordSectorCount ? sid + 1 : ENDOFCHAIN;
        view.setInt32(fatOffset + sid * 4, next | 0, true);
    }
    // 1Table chain.
    for (let i = 0; i < tableSectorCount; i++) {
        const sid = tableStartSid + i;
        const next = i + 1 < tableSectorCount ? sid + 1 : ENDOFCHAIN;
        view.setInt32(fatOffset + sid * 4, next | 0, true);
    }

    // ---- Directory (sid 1) ---------------------------------------------
    const dirOffset = 2 * SECTOR_SIZE; // header + sid=1
    writeDirectoryEntry(view, dirOffset + 0 * 128, 'Root Entry', 5, 0, 0);
    writeDirectoryEntry(
        view,
        dirOffset + 1 * 128,
        'WordDocument',
        2,
        wordStartSid,
        wordStream.length
    );
    writeDirectoryEntry(
        view,
        dirOffset + 2 * 128,
        '1Table',
        2,
        tableStartSid,
        tableStream.length
    );

    // ---- Stream sectors ------------------------------------------------
    // WordDocument chain.
    const wordPaddedLen = ceilToSector(Math.max(1, wordStream.length));
    file.set(
        wordStream.subarray(0, wordStream.length),
        (1 + wordStartSid) * SECTOR_SIZE
    );
    // (Padding bytes after `wordStream.length` stay zero from the
    // initial allocation.)
    void wordPaddedLen;
    // 1Table chain.
    file.set(
        tableStream.subarray(0, tableStream.length),
        (1 + tableStartSid) * SECTOR_SIZE
    );

    return file;
}

function writeDirectoryEntry(
    view: DataView,
    offset: number,
    name: string,
    type: number,
    startSector: number,
    size: number
): void {
    const buffer = new Uint8Array(view.buffer, view.byteOffset + offset, 128);
    // UTF-16LE name + trailing NUL.
    for (let i = 0; i < name.length; i++) {
        view.setUint16(offset + i * 2, name.charCodeAt(i), true);
    }
    view.setUint16(offset + name.length * 2, 0, true);
    // Name length in *bytes*, including the trailing NUL.
    view.setUint16(offset + 64, (name.length + 1) * 2, true);
    buffer[66] = type;          // object type
    buffer[67] = 0x01;          // colour (red)
    view.setInt32(offset + 68, -1, true); // left sibling
    view.setInt32(offset + 72, -1, true); // right sibling
    view.setInt32(offset + 76, -1, true); // child
    // CLSID + state bits + creation/modified time -> all zero.
    view.setInt32(offset + 116, startSector, true);
    view.setUint32(offset + 120, size, true);
    view.setUint32(offset + 124, 0, true);
}

// ---------------------------------------------------------------------------
// FIB / piece-table builders
//
// We build the WordDocument stream as a 512-byte FIB followed by raw
// text bytes, and we build a 1Table stream that contains a CLX block
// (one 0x02 record with cps + a single PCD). The CLX `fc` field
// stored in the FIB points the parser at offset 0 of the table
// stream.
// ---------------------------------------------------------------------------

interface BuildPieceParams {
    /**
     * If `wide`, the `text` is UTF-16LE; otherwise it's a single-byte
     * ANSI buffer (caller must pre-encode using the right code page).
     */
    wide: boolean;
    /**
     * The text bytes to embed in the WordDocument stream after the
     * 512-byte FIB.
     */
    bytes: Uint8Array;
    /**
     * Number of CHARACTERS represented by `bytes` (compressed pieces
     * have charCount === bytes.length, wide pieces have
     * charCount === bytes.length / 2).
     */
    charCount: number;
}

const FIB_SIZE = 512;

function buildWordStream(piece: BuildPieceParams): Uint8Array {
    // FIB layout we emit (offsets into the WordDocument stream):
    //   0x00  wIdent / nFib / fcMin etc. - we set nFib at offset 2
    //         to 0x00C1 (Word 97).
    //   0x0a  flags (bit 9 == fWhichTblStm). We set bit 9 -> 1Table.
    //   0x20  csw  (count of 16-bit words in fibRgW97)  = 14
    //         (28 bytes)
    //   ...   fibRgW97 (zeros)
    //   .     cslw (count of 32-bit words in fibRgLw97) = 22
    //         (88 bytes); but we only fill in CcpText at index 12.
    //   .     fibRgLw97
    //   .     cbRgFcLcb (count of FcLcb pairs)          = 50
    //   .     fibRgFcLcb -- only pair index 33 is non-zero (the CLX).
    const stream = new Uint8Array(FIB_SIZE + piece.bytes.length);
    const view = new DataView(stream.buffer);
    // Magic + nFib.
    view.setUint16(0, 0xa5ec, true); // wIdent
    view.setUint16(2, 0x00c1, true); // nFib (Word 97)
    // flags: bit 9 (fWhichTblStm) -> 1Table.
    view.setUint16(10, 1 << 9, true);
    let cursor = 32;
    // csw + fibRgW97.
    const csw = 14;
    view.setUint16(cursor, csw, true);
    cursor += 2 + csw * 2;
    // cslw + fibRgLw97.
    const cslw = 22;
    view.setUint16(cursor, cslw, true);
    cursor += 2;
    const fibRgLwOffset = cursor;
    // ccpText at index 12 (offset 12 into fibRgLw97).
    view.setUint32(fibRgLwOffset + 12, piece.charCount, true);
    // Other CCPs (ftn, hdd, ...) left as 0.
    cursor += cslw * 4;
    // cbRgFcLcb + pairs.
    const cbRgFcLcb = 50;
    view.setUint16(cursor, cbRgFcLcb, true);
    cursor += 2;
    const pairsOffset = cursor;
    // Pair 33 (the CLX): fc=0, lcb=clxLength. We compute the lcb
    // outside (we know it: 4-byte 0x02 marker length + (charCount + 1)*4
    // CPs + 8 bytes PCD = ... well the *parser* reads lcb from the CLX
    // stream itself. The FIB just needs the `fc` to point at the start
    // of the CLX in the table stream.
    view.setUint32(pairsOffset + 33 * 8, 0, true); // fcClx
    // We'll set `lcbClx` once the caller gives us the table stream.
    // Since this helper builds only the WordDocument stream, we set
    // a placeholder large value so the FIB validates and let the
    // CLX-walker stop at its own marker boundary. The parser actually
    // reads the lcb of the *0x02 record* from inside the CLX, so the
    // FIB lcb just needs to be >= the real size.
    view.setUint32(pairsOffset + 33 * 8 + 4, 65536, true);
    // Append text bytes after the FIB.
    stream.set(piece.bytes, FIB_SIZE);
    return stream;
}

function buildTableStreamWithSinglePiece(params: {
    fcInWordStream: number;
    charCount: number;
    compressed: boolean;
}): Uint8Array {
    const { fcInWordStream, charCount, compressed } = params;
    // Layout:
    //   [0x02][lcb:uint32][cp[0]:u32][cp[1]:u32][pcd:8 bytes]
    // Where pcd[2..6] is the FC field; bit 30 is the compressed flag.
    // For compressed pieces, the on-disk address is `fc * 2` -- so we
    // pre-double the offset before setting bit 30.
    const cpBytes = (1 + 1) * 4;          // two CPs: 0 and charCount.
    const pcdBytes = 8;
    const lcb = cpBytes + pcdBytes;
    const stream = new Uint8Array(1 + 4 + lcb);
    const view = new DataView(stream.buffer);
    stream[0] = 0x02;
    view.setUint32(1, lcb, true);
    // CPs at offset 5.
    view.setUint32(5, 0, true);
    view.setUint32(5 + 4, charCount, true);
    // PCD at offset 5 + cpBytes. PCD layout:
    //   bytes 0..1: prm (paragraph mark - we leave zero)
    //   bytes 2..5: fc (with high bit 30 = compressed flag)
    //   bytes 6..7: prm (we leave zero)
    const pcdOffset = 5 + cpBytes;
    view.setUint16(pcdOffset, 0, true);
    let fcField: number;
    if (compressed) {
        // For compressed pieces the on-disk address is fc*2, with bit
        // 30 set. The parser does ((fcRaw & 0x3fffffff) >>> 1).
        fcField = (fcInWordStream * 2) | 0x40000000;
    } else {
        fcField = fcInWordStream & 0x3fffffff;
    }
    view.setUint32(pcdOffset + 2, fcField >>> 0, true);
    view.setUint16(pcdOffset + 6, 0, true);
    return stream;
}

function buildDocFromText(
    rawText: string,
    encoding: 'cp1252' | 'utf16le' | 'cp949'
): Uint8Array {
    let bytes: Uint8Array;
    let charCount: number;
    let compressed: boolean;
    if (encoding === 'utf16le') {
        const view = new ArrayBuffer(rawText.length * 2);
        const dv = new DataView(view);
        for (let i = 0; i < rawText.length; i++) {
            dv.setUint16(i * 2, rawText.charCodeAt(i), true);
        }
        bytes = new Uint8Array(view);
        charCount = rawText.length;
        compressed = false;
    } else {
        // cp1252 ASCII subset; for cp949 we let callers prebuild.
        bytes = new Uint8Array(rawText.length);
        for (let i = 0; i < rawText.length; i++) {
            bytes[i] = rawText.charCodeAt(i) & 0xff;
        }
        charCount = rawText.length;
        compressed = true;
    }
    const wordStream = buildWordStream({
        wide: !compressed,
        bytes,
        charCount
    });
    const tableStream = buildTableStreamWithSinglePiece({
        fcInWordStream: FIB_SIZE,
        charCount,
        compressed
    });
    return buildMinimalCfb({ wordStream, tableStream });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isCfbMagic', () => {
    it('matches the canonical D0 CF 11 E0 A1 B1 1A E1 signature', () => {
        const bytes = new Uint8Array([
            0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00
        ]);
        expect(isCfbMagic(bytes)).toBe(true);
    });

    it('rejects a non-CFB buffer (PDF magic)', () => {
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
        expect(isCfbMagic(bytes)).toBe(false);
    });

    it('rejects a buffer that is too short', () => {
        const bytes = new Uint8Array([0xd0, 0xcf, 0x11]);
        expect(isCfbMagic(bytes)).toBe(false);
    });
});

describe('parseCfb', () => {
    it('throws on a buffer smaller than one sector', () => {
        const tiny = new Uint8Array(64);
        expect(() => parseCfb(tiny)).toThrow(/too small/i);
    });

    it('throws when the signature is wrong', () => {
        const bogus = new Uint8Array(SECTOR_SIZE * 2);
        bogus[0] = 0x50;
        bogus[1] = 0x4b; // PK -- ZIP magic
        expect(() => parseCfb(bogus)).toThrow(/signature/i);
    });

    it('exposes the WordDocument and 1Table streams from a minimal container', () => {
        const wordStream = new Uint8Array(FIB_SIZE);
        // mark the FIB so we can verify round-tripping.
        wordStream[0] = 0xec;
        wordStream[1] = 0xa5;
        const tableStream = new Uint8Array(64);
        tableStream[0] = 0x42;
        const file = buildMinimalCfb({ wordStream, tableStream });
        const cfb = parseCfb(file);
        const got = cfb.getStream('WordDocument');
        const tab = cfb.getStream('1Table');
        expect(got).not.toBeNull();
        expect(tab).not.toBeNull();
        expect(got!.byteLength).toBe(FIB_SIZE);
        expect(got![0]).toBe(0xec);
        expect(got![1]).toBe(0xa5);
        expect(tab![0]).toBe(0x42);
    });

    it('lists registered streams', () => {
        const file = buildMinimalCfb({
            wordStream: new Uint8Array(FIB_SIZE),
            tableStream: new Uint8Array(64)
        });
        const cfb = parseCfb(file);
        const names = cfb.listStreams().map((s) => s.name).sort();
        expect(names).toEqual(['1Table', 'WordDocument']);
    });
});

describe('parseFib', () => {
    it('reads the table stream selector + ccpText', () => {
        const stream = buildWordStream({
            wide: false,
            bytes: new Uint8Array([0x41, 0x42, 0x43]),
            charCount: 3
        });
        const fib = parseFib(stream);
        expect(fib.tableStreamName).toBe('1Table');
        expect(fib.ccpText).toBe(3);
        expect(fib.fcClx).toBe(0);
        expect(fib.lcbClx).toBeGreaterThan(0);
    });

    it('throws on a truncated WordDocument stream', () => {
        expect(() => parseFib(new Uint8Array(8))).toThrow(/FIB base/i);
    });
});

describe('parseDocBuffer (compressed pieces / Latin-1)', () => {
    it('extracts plain ASCII paragraphs separated by 0x0d (CR)', () => {
        // Build a piece with two paragraphs separated by 0x0d.
        const text = 'Hello, world!\rGoodbye!';
        const cfb = buildDocFromText(text, 'cp1252');
        const parsed = parseDocBuffer(cfb);
        expect(parsed.paragraphs).toEqual(['Hello, world!', 'Goodbye!']);
        expect(parsed.tableStreamName).toBe('1Table');
        expect(parsed.sourceFormat).toBe('doc');
    });

    it('treats 0x07 (BEL = table cell mark) as a paragraph separator', () => {
        const text = 'Cell1\x07Cell2\x07Cell3\r';
        const cfb = buildDocFromText(text, 'cp1252');
        const parsed = parseDocBuffer(cfb);
        expect(parsed.paragraphs).toEqual(['Cell1', 'Cell2', 'Cell3']);
    });

    it('drops NUL padding bytes from the decoded text', () => {
        const text = 'A\x00B\x00C\rD';
        const cfb = buildDocFromText(text, 'cp1252');
        const parsed = parseDocBuffer(cfb);
        // NULs are stripped; the rest of the line is preserved.
        expect(parsed.paragraphs).toEqual(['ABC', 'D']);
    });
});

describe('parseDocBuffer (UTF-16LE pieces)', () => {
    it('decodes a non-compressed piece using TextDecoder utf-16le', () => {
        const text = 'wide!\rsecond';
        const cfb = buildDocFromText(text, 'utf16le');
        const parsed = parseDocBuffer(cfb);
        expect(parsed.paragraphs).toEqual(['wide!', 'second']);
    });

    it('decodes Hangul characters from a UTF-16LE piece (Korean smoke test)', () => {
        const text = '안녕하세요\r반갑습니다';
        const cfb = buildDocFromText(text, 'utf16le');
        const parsed = parseDocBuffer(cfb);
        expect(parsed.paragraphs).toEqual(['안녕하세요', '반갑습니다']);
    });
});

describe('parseDocBuffer (CP949 / EUC-KR detection)', () => {
    it('picks the EUC-KR decoder when the bytes form valid Hangul', () => {
        // Build the CP949-encoded byte string for "안녕\r" using
        // TextEncoder's missing CP949 support is *not* an option in the
        // browser, so we hand-encode known CP949 codepoints:
        //   안 = 0xBE 0xC8
        //   녕 = 0xB3 0xE7
        const bytes = new Uint8Array([0xbe, 0xc8, 0xb3, 0xe7, 0x0d]);
        const wordStream = buildWordStream({
            wide: false,
            bytes,
            charCount: bytes.length
        });
        const tableStream = buildTableStreamWithSinglePiece({
            fcInWordStream: FIB_SIZE,
            charCount: bytes.length,
            compressed: true
        });
        const file = buildMinimalCfb({ wordStream, tableStream });
        const parsed = parseDocBuffer(file);
        expect(parsed.paragraphs).toEqual(['안녕']);
    });
});

describe('extractFromClx', () => {
    it('returns null when the FIB CLX pair is empty', () => {
        const wordStream = new Uint8Array(FIB_SIZE);
        const tableStream = new Uint8Array(0);
        const fib = parseFib(
            buildWordStream({
                wide: false,
                bytes: new Uint8Array(0),
                charCount: 0
            })
        );
        // Override lcbClx to 0 to simulate the "no piece table" case.
        const result = extractFromClx(wordStream, tableStream, {
            ...fib,
            fcClx: 0,
            lcbClx: 0
        });
        expect(result).toBeNull();
    });
});

describe('normalizeDocumentText', () => {
    it('strips NULs', () => {
        expect(normalizeDocumentText('A\x00B')).toBe('AB');
    });

    it('maps low-ASCII control noise to a single space', () => {
        // 0x14..0x1f range -> single space, then collapsed.
        expect(normalizeDocumentText('A\x14\x15\x16B')).toBe('A B');
    });

    it('collapses 3+ newlines to a paragraph break', () => {
        expect(normalizeDocumentText('A\r\r\r\rB')).toBe('A\n\nB');
    });

    it('strips field-code noise (HYPERLINK / PAGEREF)', () => {
        expect(
            normalizeDocumentText('see HYPERLINK "http://x" here')
        ).toBe('see here');
    });
});

describe('escapeHtml', () => {
    it('escapes the five HTML metacharacters', () => {
        expect(escapeHtml('<a href="x&y">\'</a>')).toBe(
            '&lt;a href=&quot;x&amp;y&quot;&gt;&#39;&lt;/a&gt;'
        );
    });
});

describe('fileUtils/word.ts (extension + magic detection)', () => {
    // Importing inside the describe block avoids hoisting concerns
    // around the TextDecoder shim, since `detectWordFormat` itself
    // never touches `TextDecoder` -- but `looksLikeCfbContainer`
    // routes through the parser which does.
    const wordUtils = require('../utils/fileUtils/word');

    it('classifies .docx by extension as docx', () => {
        expect(wordUtils.detectWordFormatByName('Foo.docx')).toBe('docx');
        expect(wordUtils.detectWordFormatByName('Foo.DOCX')).toBe('docx');
        expect(wordUtils.detectWordFormatByName('Foo.dotx')).toBe('docx');
    });

    it('classifies .doc / .dot by extension as doc', () => {
        expect(wordUtils.detectWordFormatByName('Foo.doc')).toBe('doc');
        expect(wordUtils.detectWordFormatByName('Foo.DOC')).toBe('doc');
        expect(wordUtils.detectWordFormatByName('Foo.dot')).toBe('doc');
    });

    it('returns unknown for an empty / unrelated name', () => {
        expect(wordUtils.detectWordFormatByName('')).toBe('unknown');
        expect(wordUtils.detectWordFormatByName('Foo.txt')).toBe('unknown');
    });

    it('exposes the canonical CFB magic constants', () => {
        expect(wordUtils.WORD_DOC_MAGIC_LENGTH).toBe(8);
        expect(Array.from(wordUtils.WORD_DOC_MAGIC)).toEqual([
            0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1
        ]);
    });

    it('looksLikeCfbContainer matches the magic and rejects ZIP', () => {
        const cfb = new Uint8Array([
            0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0
        ]);
        const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
        expect(wordUtils.looksLikeCfbContainer(cfb)).toBe(true);
        expect(wordUtils.looksLikeCfbContainer(zip)).toBe(false);
    });

    it('looksLikeZipContainer matches the PK\\x03\\x04 signature', () => {
        const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
        const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
        expect(wordUtils.looksLikeZipContainer(zip)).toBe(true);
        expect(wordUtils.looksLikeZipContainer(cfb)).toBe(false);
    });
});

describe('parseDocToHtml', () => {
    it('renders one <p> per paragraph with HTML escaping', () => {
        const cfb = buildDocFromText('Hi <there>\rsecond & line', 'cp1252');
        const html = parseDocToHtml(cfb);
        expect(html).toContain('<p>Hi &lt;there&gt;</p>');
        expect(html).toContain('<p>second &amp; line</p>');
    });

    it('emits an empty-state placeholder when nothing decodes', () => {
        // Build a minimal CFB with a WordDocument that has charCount=0
        // -> the piece-table walker bails out and we fall through to
        // the empty-state HTML.
        const wordStream = buildWordStream({
            wide: false,
            bytes: new Uint8Array(0),
            charCount: 0
        });
        const tableStream = buildTableStreamWithSinglePiece({
            fcInWordStream: FIB_SIZE,
            charCount: 0,
            compressed: true
        });
        const file = buildMinimalCfb({ wordStream, tableStream });
        const html = parseDocToHtml(file);
        expect(html).toContain('No readable text content');
    });
});
