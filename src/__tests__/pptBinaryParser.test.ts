// jest-environment-jsdom@29 does not expose TextEncoder/TextDecoder as
// globals. The legacy .ppt parser depends on `TextDecoder('utf-16le' /
// 'euc-kr' / 'shift_jis')`, so we hoist Node's util-provided
// implementation onto `globalThis` before the parser module is imported.
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof NodeTextEncoder }).TextEncoder = NodeTextEncoder;
}
if (typeof (globalThis as { TextDecoder?: unknown }).TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof NodeTextDecoder }).TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;
}

// Unit tests for the legacy .ppt CFB + record parser (issue #48).
//
// These tests build tiny synthetic compound files in-memory and assert
// that the parser:
//   1. Recognises (and rejects) the CFB magic.
//   2. Walks the FAT / directory and exposes the
//      `PowerPoint Document` stream (note: the directory name contains
//      a space, which the parser must NOT collapse).
//   3. Parses PPT records (header = ver/inst + type + length) and
//      decodes container records (recVer == 0x0f) into a tree.
//   4. Locates `RT_Slide` (1006) container records and extracts text
//      from `TextCharsAtom` (4000 — UTF-16LE) atoms inside.
//   5. Falls back to a flat "every text atom" sweep when no slide
//      containers are present (recovery mode).
//   6. Surfaces a `PptParseResult` with one `slides[]` entry per
//      slide container, each carrying its decoded text strings.
//
// We do *not* try to reconstruct a real Microsoft PowerPoint deck —
// we just emit the smallest valid container the parser will walk so
// the failures point at real parser bugs rather than fixture bugs.

import {
    PptBinaryParser,
    isCfbMagic,
    parseCfb,
    parseRecords,
    collectSlideRecords,
    decodeTextAtom,
    extractTextsFromSlide,
    extractAllTexts,
    extractLooseTextFromCfb,
    extractLegacyBackgroundColor,
    extractLegacyDocumentBackgroundColor,
    parsePptBuffer
} from '../utils/pptBinaryParser';
import { renderLegacyPptSlide } from '../templates/ppt/js/pptSlideRenderer';

// ---------------------------------------------------------------------------
// Test fixture: minimal CFB builder
//
// We emit a compound file with:
//   - 512-byte sectors (sector shift = 9).
//   - Layout (each sector's SID is its index in the FAT, the file
//     offset is `(sid + 1) * 512` because the CFB header lives in
//     sector "-1"):
//       sid 0           -> FAT
//       sid 1           -> directory
//       sid 2..2+W-1    -> PowerPoint Document stream chain
//   - No mini-stream, no DIFAT chain (109 inline DIFAT entries are
//     plenty for a tiny container).
//
// This is intentionally analogous to `docBinaryParser.test.ts`'s
// builder; we keep an independent copy so the two tests stay
// decoupled.
// ---------------------------------------------------------------------------

const SECTOR_SIZE = 512;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

function ceilToSector(n: number): number {
    return Math.ceil(n / SECTOR_SIZE) * SECTOR_SIZE;
}

function buildPptCfb(documentStream: Uint8Array): Uint8Array {
    // Layout (each sector's SID is its index in the FAT):
    //   sid 0           -> FAT
    //   sid 1           -> directory
    //   sid 2..2+W-1    -> PowerPoint Document chain
    const docSectorCount = Math.max(1, Math.ceil(documentStream.length / SECTOR_SIZE));
    const docStartSid = 2;
    const dataSectors = 2 + docSectorCount;
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
    // sid 0 = FAT itself (FATSECT marker = 0xFFFFFFFD).
    view.setInt32(fatOffset + 0 * 4, 0xfffffffd | 0, true);
    // sid 1 = directory (single sector).
    view.setInt32(fatOffset + 1 * 4, ENDOFCHAIN | 0, true);
    // PowerPoint Document chain.
    for (let i = 0; i < docSectorCount; i++) {
        const sid = docStartSid + i;
        const next = i + 1 < docSectorCount ? sid + 1 : ENDOFCHAIN;
        view.setInt32(fatOffset + sid * 4, next | 0, true);
    }

    // ---- Directory (sid 1) ---------------------------------------------
    const dirOffset = 2 * SECTOR_SIZE; // header + sid=1
    writeDirectoryEntry(view, dirOffset + 0 * 128, 'Root Entry', 5, 0, 0);
    writeDirectoryEntry(
        view,
        dirOffset + 1 * 128,
        'PowerPoint Document',
        2,
        docStartSid,
        documentStream.length
    );

    // ---- Stream sectors ------------------------------------------------
    const docPaddedLen = ceilToSector(Math.max(1, documentStream.length));
    file.set(
        documentStream.subarray(0, documentStream.length),
        (1 + docStartSid) * SECTOR_SIZE
    );
    void docPaddedLen;

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
    // UTF-16LE name + trailing NUL. Spaces are written verbatim — the
    // PPT directory uses literal space characters in stream names like
    // "PowerPoint Document".
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
    view.setInt32(offset + 116, startSector, true);
    view.setUint32(offset + 120, size, true);
    view.setUint32(offset + 124, 0, true);
}

// ---------------------------------------------------------------------------
// PPT record builders
//
// Each PPT record header is 8 bytes:
//   u16 verInst   (low 4 bits: recVer, high 12 bits: recInstance)
//   u16 recType
//   u32 length    (size of the payload in bytes — header excluded)
//
// Container records carry `recVer == 0x0f`. Atoms (text, persist,
// styling) carry `recVer == 0x00`.
// ---------------------------------------------------------------------------

const RT_DOCUMENT = 1000;
const RT_SLIDE = 1006;
const RT_TEXT_CHARS_ATOM = 4000;
const RT_TEXT_BYTES_ATOM = 4008;
const RT_COLOR_SCHEME_ATOM = 2032;

function makeRecord(
    recType: number,
    payload: Uint8Array,
    options: { recVer?: number; recInstance?: number } = {}
): Uint8Array {
    const recVer = options.recVer ?? 0x00;
    const recInstance = options.recInstance ?? 0x000;
    const verInst = (recInstance << 4) | (recVer & 0x0f);
    const out = new Uint8Array(8 + payload.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, verInst, true);
    view.setUint16(2, recType, true);
    view.setUint32(4, payload.length, true);
    out.set(payload, 8);
    return out;
}

function makeContainer(
    recType: number,
    children: Uint8Array[],
    recInstance: number = 0
): Uint8Array {
    const total = children.reduce((sum, child) => sum + child.length, 0);
    const payload = new Uint8Array(total);
    let offset = 0;
    for (const child of children) {
        payload.set(child, offset);
        offset += child.length;
    }
    return makeRecord(recType, payload, { recVer: 0x0f, recInstance });
}

function makeTextCharsAtom(text: string): Uint8Array {
    const buf = new Uint8Array(text.length * 2);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < text.length; i++) {
        view.setUint16(i * 2, text.charCodeAt(i), true);
    }
    return makeRecord(RT_TEXT_CHARS_ATOM, buf);
}

function makeTextBytesAtom(bytes: Uint8Array): Uint8Array {
    return makeRecord(RT_TEXT_BYTES_ATOM, bytes);
}

function makeColorSchemeAtom(background: [number, number, number]): Uint8Array {
    const payload = new Uint8Array(32);
    payload.set(background, 0);
    return makeRecord(RT_COLOR_SCHEME_ATOM, payload);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isCfbMagic', () => {
    it('accepts the CFB signature', () => {
        const buf = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
        expect(isCfbMagic(buf)).toBe(true);
    });
    it('rejects byte streams that do not start with the magic', () => {
        const buf = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0]);
        expect(isCfbMagic(buf)).toBe(false);
    });
    it('rejects buffers shorter than 8 bytes', () => {
        expect(isCfbMagic(new Uint8Array([0xd0, 0xcf]))).toBe(false);
    });
});

describe('parseCfb', () => {
    it('throws on an empty buffer', () => {
        expect(() => parseCfb(new Uint8Array(64))).toThrow(/too small/i);
    });
    it('throws when the magic bytes are wrong', () => {
        const bogus = new Uint8Array(SECTOR_SIZE * 4);
        bogus[0] = 0x50;
        bogus[1] = 0x4b;
        expect(() => parseCfb(bogus)).toThrow(/CFB signature/i);
    });
    it('locates the "PowerPoint Document" stream by exact name (with space)', () => {
        const docStream = new Uint8Array([1, 2, 3, 4, 5]);
        const cfb = parseCfb(buildPptCfb(docStream));
        const got = cfb.getStream('PowerPoint Document');
        expect(got).not.toBeNull();
        expect(Array.from(got as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
    });
    it('returns null for an unknown stream name', () => {
        const cfb = parseCfb(buildPptCfb(new Uint8Array([0])));
        expect(cfb.getStream('Pictures')).toBeNull();
    });
    it('lists the streams it found', () => {
        const cfb = parseCfb(buildPptCfb(new Uint8Array([0, 0, 0])));
        const streams = cfb.listStreams();
        expect(streams.map((s) => s.name)).toContain('PowerPoint Document');
    });
});

describe('parseRecords', () => {
    it('reads a single atom record', () => {
        const atom = makeTextCharsAtom('hi');
        const records = parseRecords(atom, 0, atom.length);
        expect(records).toHaveLength(1);
        expect(records[0].recType).toBe(RT_TEXT_CHARS_ATOM);
        expect(records[0].recVer).toBe(0);
        expect(records[0].length).toBe(4); // 2 chars * 2 bytes
        expect(records[0].children).toBeUndefined();
    });
    it('descends into container records (recVer == 0x0f)', () => {
        const atom1 = makeTextCharsAtom('a');
        const atom2 = makeTextCharsAtom('b');
        const container = makeContainer(RT_SLIDE, [atom1, atom2]);
        const records = parseRecords(container, 0, container.length);
        expect(records).toHaveLength(1);
        const slide = records[0];
        expect(slide.recType).toBe(RT_SLIDE);
        expect(slide.recVer).toBe(0x0f);
        expect(slide.children).toHaveLength(2);
        expect(slide.children?.[0].recType).toBe(RT_TEXT_CHARS_ATOM);
        expect(slide.children?.[1].recType).toBe(RT_TEXT_CHARS_ATOM);
    });
    it('stops cleanly when a record claims more bytes than remain', () => {
        // Forge a record header whose declared length runs past EOF.
        const buf = new Uint8Array(8);
        const view = new DataView(buf.buffer);
        view.setUint16(0, 0x0000, true); // verInst
        view.setUint16(2, RT_SLIDE, true);
        view.setUint32(4, 0xffff0000, true); // huge length
        const records = parseRecords(buf, 0, buf.length);
        expect(records).toHaveLength(0);
    });
});

describe('decodeTextAtom', () => {
    it('decodes UTF-16LE from RT_TEXT_CHARS_ATOM (4000)', () => {
        const records = parseRecords(makeTextCharsAtom('hello'), 0, makeTextCharsAtom('hello').length);
        expect(decodeTextAtom(records[0])).toBe('hello');
    });
    it('decodes ASCII from RT_TEXT_BYTES_ATOM (4008)', () => {
        const bytes = new TextEncoder().encode('legacy');
        const atom = makeTextBytesAtom(bytes);
        const records = parseRecords(atom, 0, atom.length);
        const decoded = decodeTextAtom(records[0]);
        expect(decoded).toBe('legacy');
    });
    it('returns null for non-text record types', () => {
        const noise = makeRecord(0x1234, new Uint8Array([1, 2, 3, 4]));
        const records = parseRecords(noise, 0, noise.length);
        expect(decodeTextAtom(records[0])).toBeNull();
    });
    it('returns null for empty / mis-aligned UTF-16 payloads', () => {
        const odd = makeRecord(RT_TEXT_CHARS_ATOM, new Uint8Array([0x41]));
        const records = parseRecords(odd, 0, odd.length);
        expect(decodeTextAtom(records[0])).toBeNull();
    });
});

describe('collectSlideRecords + extractTextsFromSlide', () => {
    it('finds RT_Slide containers and surfaces their text atoms in order', () => {
        const slideA = makeContainer(RT_SLIDE, [
            makeTextCharsAtom('Slide A title'),
            makeTextCharsAtom('Slide A body')
        ]);
        const slideB = makeContainer(RT_SLIDE, [
            makeTextCharsAtom('Slide B only')
        ]);
        // Wrap inside an RT_Document-ish container so we exercise the
        // tree walker rather than the top-level list iteration.
        const doc = makeContainer(RT_DOCUMENT, [slideA, slideB]);
        const records = parseRecords(doc, 0, doc.length);
        const slides = collectSlideRecords(records);
        expect(slides).toHaveLength(2);
        expect(extractTextsFromSlide(slides[0])).toEqual([
            'Slide A title',
            'Slide A body'
        ]);
        expect(extractTextsFromSlide(slides[1])).toEqual(['Slide B only']);
    });

    it('walks deeply nested containers (e.g. SpContainer/ClientTextBox)', () => {
        // Mock OfficeArt nesting: Slide -> SpContainer (0xf004) ->
        // ClientTextBox (0xf00d) -> TextChars. The parser doesn't care
        // about the specific inner record types — just that recVer==0x0f
        // makes them containers.
        const inner = makeContainer(0xf00d, [makeTextCharsAtom('nested')]);
        const sp = makeContainer(0xf004, [inner]);
        const slide = makeContainer(RT_SLIDE, [sp]);
        const records = parseRecords(slide, 0, slide.length);
        const slides = collectSlideRecords(records);
        expect(slides).toHaveLength(1);
        expect(extractTextsFromSlide(slides[0])).toEqual(['nested']);
    });

    it('strips NUL padding from UTF-16 strings', () => {
        // Some PPT exporters pad TextChars with a trailing NUL; the
        // parser should drop it rather than surface a U+0000 char.
        const bytes = new Uint8Array(8);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, 'h'.charCodeAt(0), true);
        view.setUint16(2, 'i'.charCodeAt(0), true);
        view.setUint16(4, 0, true);
        view.setUint16(6, 0, true);
        const atom = makeRecord(RT_TEXT_CHARS_ATOM, bytes);
        const records = parseRecords(atom, 0, atom.length);
        expect(decodeTextAtom(records[0])).toBe('hi');
    });
});

describe('extractAllTexts (recovery fallback)', () => {
    it('walks the whole tree and dedupes text atoms', () => {
        const a = makeTextCharsAtom('repeat');
        const b = makeTextCharsAtom('unique');
        const c = makeTextCharsAtom('repeat');
        const root = makeContainer(RT_DOCUMENT, [a, b, c]);
        const records = parseRecords(root, 0, root.length);
        expect(extractAllTexts(records)).toEqual(['repeat', 'unique']);
    });
});

describe('parsePptBuffer (end-to-end)', () => {
    it('parses a complete CFB -> records -> slides chain', () => {
        const slide = makeContainer(RT_SLIDE, [
            makeTextCharsAtom('Hello slide')
        ]);
        const docStream = makeContainer(RT_DOCUMENT, [slide]);
        const cfb = buildPptCfb(docStream);
        const result = parsePptBuffer(cfb);
        expect(result.totalSlides).toBe(1);
        expect(result.slides[0].slideNumber).toBe(1);
        expect(result.slides[0].texts).toEqual(['Hello slide']);
    });

    it('numbers slides sequentially in document order', () => {
        const slides = [
            makeContainer(RT_SLIDE, [makeTextCharsAtom('one')]),
            makeContainer(RT_SLIDE, [makeTextCharsAtom('two')]),
            makeContainer(RT_SLIDE, [makeTextCharsAtom('three')])
        ];
        const docStream = makeContainer(RT_DOCUMENT, slides);
        const result = parsePptBuffer(buildPptCfb(docStream));
        expect(result.totalSlides).toBe(3);
        expect(result.slides.map((s) => s.slideNumber)).toEqual([1, 2, 3]);
        expect(result.slides.map((s) => s.texts.join('|'))).toEqual([
            'one',
            'two',
            'three'
        ]);
    });

    it('uses a slide ColorSchemeAtom background override', () => {
        const slide = makeContainer(RT_SLIDE, [
            makeColorSchemeAtom([0x12, 0x34, 0x56]),
            makeTextCharsAtom('colored slide')
        ]);
        const result = parsePptBuffer(buildPptCfb(makeContainer(RT_DOCUMENT, [slide])));
        expect(result.slides[0].backgroundColor).toBe('#123456');
    });

    it('inherits the document ColorSchemeAtom background', () => {
        const slide = makeContainer(RT_SLIDE, [makeTextCharsAtom('inherited')]);
        const docStream = makeContainer(RT_DOCUMENT, [
            makeColorSchemeAtom([0xab, 0xcd, 0xef]),
            slide
        ]);
        const result = parsePptBuffer(buildPptCfb(docStream));
        expect(result.slides[0].backgroundColor).toBe('#abcdef');
    });

    it('falls back to a single recovery slide when no RT_Slide containers exist', () => {
        // Only a Document container with text atoms — no RT_Slide.
        const docStream = makeContainer(RT_DOCUMENT, [
            makeTextCharsAtom('orphan title'),
            makeTextCharsAtom('orphan body')
        ]);
        const result = parsePptBuffer(buildPptCfb(docStream));
        expect(result.totalSlides).toBe(1);
        expect(result.slides[0].slideNumber).toBe(1);
        expect(result.slides[0].texts).toContain('orphan title');
        expect(result.slides[0].texts).toContain('orphan body');
    });

    it('returns zero slides when the stream contains no decodable text', () => {
        const docStream = new Uint8Array(0);
        const result = parsePptBuffer(buildPptCfb(docStream));
        expect(result.totalSlides).toBe(0);
        expect(result.slides).toHaveLength(0);
    });

    it('throws when the PowerPoint Document stream is missing', () => {
        // Build a CFB whose only stream is named "OtherStream" — the
        // parser should raise rather than silently surface an empty
        // result, mirroring the .doc parser's contract.
        const cfb = (() => {
            const docStream = new Uint8Array([0]);
            const file = buildPptCfb(docStream);
            // Replace the directory entry name "PowerPoint Document"
            // with a different label of the same byte length.
            const dirOffset = 2 * SECTOR_SIZE; // header + sid=1
            const view = new DataView(file.buffer);
            const replacement = 'OtherStreamXxxxxxxx'; // same length
            const entryOffset = dirOffset + 1 * 128;
            for (let i = 0; i < replacement.length; i++) {
                view.setUint16(entryOffset + i * 2, replacement.charCodeAt(i), true);
            }
            return file;
        })();
        expect(() => parsePptBuffer(cfb)).toThrow(/PowerPoint Document/i);
    });
});

describe('legacy ColorSchemeAtom helpers', () => {
    it('extracts a direct background and finds a nested document default', () => {
        const slideBytes = makeContainer(RT_SLIDE, [makeColorSchemeAtom([1, 2, 3])]);
        const docBytes = makeContainer(RT_DOCUMENT, [makeColorSchemeAtom([4, 5, 6]), slideBytes]);
        const records = parseRecords(docBytes, 0, docBytes.length);
        const slide = collectSlideRecords(records)[0];
        expect(extractLegacyBackgroundColor(slide)).toBe('#010203');
        expect(extractLegacyDocumentBackgroundColor(records)).toBe('#040506');
    });
});

describe('legacy slide background rendering', () => {
    it('paints the parsed ColorSchemeAtom background on the slide frame', () => {
        const target = document.createElement('div');
        renderLegacyPptSlide({
            slide: {
                slideNumber: 1,
                backgroundColor: '#123456',
                texts: ['content'],
                elements: [{ kind: 'text', text: 'content' }]
            },
            metrics: { widthPx: 960, heightPx: 720, rawWidth: 5760, rawHeight: 4320 }
        }, target);
        expect(target.querySelector<HTMLElement>('.pv-slide-frame')?.style.background).toBe('rgb(18, 52, 86)');
    });
});

describe('PptBinaryParser class wrapper', () => {
    it('parseBuffer returns the same shape as parsePptBuffer', () => {
        const slide = makeContainer(RT_SLIDE, [makeTextCharsAtom('via class')]);
        const docStream = makeContainer(RT_DOCUMENT, [slide]);
        const cfb = buildPptCfb(docStream);
        const direct = parsePptBuffer(cfb);
        const viaClass = PptBinaryParser.parseBuffer(cfb);
        expect(viaClass).toEqual(direct);
    });

    it('parseFile reads the buffer from a File-like input', async () => {
        const slide = makeContainer(RT_SLIDE, [makeTextCharsAtom('via file')]);
        const docStream = makeContainer(RT_DOCUMENT, [slide]);
        const cfb = buildPptCfb(docStream);
        const fileLike = {
            arrayBuffer: async (): Promise<ArrayBuffer> => {
                // Return a fresh ArrayBuffer that isn't a SharedArrayBuffer.
                const out = new ArrayBuffer(cfb.byteLength);
                new Uint8Array(out).set(cfb);
                return out;
            }
        };
        const result = await PptBinaryParser.parseFile(fileLike);
        expect(result.totalSlides).toBe(1);
        expect(result.slides[0].texts).toEqual(['via file']);
    });
});

// ---------------------------------------------------------------------------
// Issue #78 — Tier 1: presentation metrics, pictures, shape bounds, slide
// elements. The fixtures below build synthetic OfficeArt + DocumentAtom
// records on top of the same makeRecord/makeContainer helpers used by the
// baseline tests.
// ---------------------------------------------------------------------------

import {
    extractPicturesFromStream,
    extractPresentationMetrics,
    extractShapeBoundsFromSpContainer,
    extractSlideElements,
    readRectBounds32
} from '../utils/pptBinaryParser';

const RT_DOCUMENT_ATOM = 1001;
const OFFICE_ART_SP_CONTAINER = 0xf004;
const OFFICE_ART_CLIENT_ANCHOR = 0xf010;
const OFFICE_ART_ANCHOR_RECT = 0xf00f;
const OFFICE_ART_CLIENT_TEXTBOX = 0xf00d;
const OFFICE_ART_OPT = 0xf00b;

function makeDocumentAtom(slideX: number, slideY: number): Uint8Array {
    // DocumentAtom layout: slideX (u32), slideY (u32), notesX (u32),
    // notesY (u32) and a long tail we don't read. We emit just the
    // first 16 bytes so the parser's `payload.length >= 8` check passes.
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    view.setUint32(0, slideX, true);
    view.setUint32(4, slideY, true);
    view.setUint32(8, slideX, true);
    view.setUint32(12, slideY, true);
    return makeRecord(RT_DOCUMENT_ATOM, payload);
}

function makeRect32Anchor(
    recType: number,
    left: number,
    top: number,
    right: number,
    bottom: number
): Uint8Array {
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    view.setInt32(0, left, true);
    view.setInt32(4, top, true);
    view.setInt32(8, right, true);
    view.setInt32(12, bottom, true);
    return makeRecord(recType, payload);
}

function makeOptProperty(opid: number, value: number): { opid: number; value: number } {
    return { opid, value };
}

function makeOptRecord(props: Array<{ opid: number; value: number }>): Uint8Array {
    // recInstance carries the property count; payload is 6 bytes per
    // property (u16 opid + u32 value).
    const payload = new Uint8Array(props.length * 6);
    const view = new DataView(payload.buffer);
    props.forEach((prop, idx) => {
        view.setUint16(idx * 6, prop.opid, true);
        view.setUint32(idx * 6 + 2, prop.value, true);
    });
    return makeRecord(OFFICE_ART_OPT, payload, { recInstance: props.length });
}

describe('extractPresentationMetrics (DocumentAtom)', () => {
    it('reads slide dimensions from DocumentAtom in master units', () => {
        // 5760 / 4320 master units = 10" x 7.5" = 960 x 720 px @ 96 DPI.
        const docAtom = makeDocumentAtom(5760, 4320);
        const doc = makeContainer(RT_DOCUMENT, [docAtom]);
        const records = parseRecords(doc, 0, doc.length);
        const metrics = extractPresentationMetrics(records);
        expect(metrics.rawWidth).toBe(5760);
        expect(metrics.rawHeight).toBe(4320);
        expect(metrics.widthPx).toBe(960);
        expect(metrics.heightPx).toBe(720);
    });

    it('falls back to 720x540 when DocumentAtom is missing', () => {
        const doc = makeContainer(RT_DOCUMENT, [makeTextCharsAtom('no doc atom')]);
        const records = parseRecords(doc, 0, doc.length);
        const metrics = extractPresentationMetrics(records);
        expect(metrics.widthPx).toBe(720);
        expect(metrics.heightPx).toBe(540);
    });
});

describe('extractPicturesFromStream', () => {
    it('returns an empty map when the stream is missing or empty', () => {
        expect(extractPicturesFromStream(null).size).toBe(0);
        expect(extractPicturesFromStream(new Uint8Array(0)).size).toBe(0);
    });

    it('extracts a single PNG between leading padding and trailing noise', () => {
        // 8-byte PNG signature, IHDR (13 bytes data + length + type +
        // CRC), IEND (0 data + length + type + CRC). 8 + 25 + 12 = 45.
        const png = buildMinimalPng();
        const stream = new Uint8Array(10 + png.length + 5);
        stream.set(png, 10);
        const map = extractPicturesFromStream(stream);
        expect(map.size).toBe(1);
        const asset = map.get(1);
        expect(asset?.mime).toBe('image/png');
        expect(asset?.bytes).toEqual(png);
    });

    it('extracts a tiny JPEG', () => {
        const jpeg = buildMinimalJpeg();
        const stream = new Uint8Array(jpeg.length + 4);
        stream.set(jpeg, 0);
        const map = extractPicturesFromStream(stream);
        expect(map.size).toBe(1);
        const asset = map.get(1);
        expect(asset?.mime).toBe('image/jpeg');
        expect(asset?.bytes.length).toBe(jpeg.length);
    });

    it('extracts a tiny DIB (BMP) by header length', () => {
        const bmp = buildMinimalBmp(40);
        const stream = new Uint8Array(bmp.length);
        stream.set(bmp, 0);
        const map = extractPicturesFromStream(stream);
        expect(map.size).toBe(1);
        const asset = map.get(1);
        expect(asset?.mime).toBe('image/bmp');
        expect(asset?.bytes.length).toBe(40);
    });

    it('extracts a PNG and a JPEG out of the same stream (sequential ids)', () => {
        const png = buildMinimalPng();
        const jpeg = buildMinimalJpeg();
        const stream = new Uint8Array(png.length + jpeg.length);
        stream.set(png, 0);
        stream.set(jpeg, png.length);
        const map = extractPicturesFromStream(stream);
        expect(map.size).toBe(2);
        // Order: PNG scan runs first, so id=1 is the PNG.
        expect(map.get(1)?.mime).toBe('image/png');
        expect(map.get(2)?.mime).toBe('image/jpeg');
    });
});

describe('readRectBounds32 + extractShapeBoundsFromSpContainer', () => {
    it('decodes a 16-byte rect into {x,y,w,h}', () => {
        const payload = new Uint8Array(16);
        const view = new DataView(payload.buffer);
        view.setInt32(0, 100, true);
        view.setInt32(4, 200, true);
        view.setInt32(8, 700, true);
        view.setInt32(12, 600, true);
        const bounds = readRectBounds32(payload);
        expect(bounds).toEqual({ x: 100, y: 200, width: 600, height: 400 });
    });

    it('returns undefined when right <= left or bottom <= top', () => {
        const payload = new Uint8Array(16);
        const view = new DataView(payload.buffer);
        view.setInt32(0, 700, true);
        view.setInt32(4, 200, true);
        view.setInt32(8, 100, true);
        view.setInt32(12, 600, true);
        expect(readRectBounds32(payload)).toBeUndefined();
    });

    it('pulls bounds from an SpContainer with a ClientAnchor (0xF010)', () => {
        const anchor = makeRect32Anchor(OFFICE_ART_CLIENT_ANCHOR, 50, 60, 350, 260);
        const sp = makeContainer(OFFICE_ART_SP_CONTAINER, [anchor]);
        const records = parseRecords(sp, 0, sp.length);
        const bounds = extractShapeBoundsFromSpContainer(records[0]);
        expect(bounds).toEqual({ x: 50, y: 60, width: 300, height: 200 });
    });

    it('pulls bounds from an SpContainer with an Anchor (0xF00F) rect', () => {
        const anchor = makeRect32Anchor(OFFICE_ART_ANCHOR_RECT, 0, 0, 1000, 500);
        const sp = makeContainer(OFFICE_ART_SP_CONTAINER, [anchor]);
        const records = parseRecords(sp, 0, sp.length);
        const bounds = extractShapeBoundsFromSpContainer(records[0]);
        expect(bounds).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
    });

    it('returns undefined for an SpContainer with no anchor record', () => {
        const sp = makeContainer(OFFICE_ART_SP_CONTAINER, [makeTextCharsAtom('no anchor')]);
        const records = parseRecords(sp, 0, sp.length);
        expect(extractShapeBoundsFromSpContainer(records[0])).toBeUndefined();
    });
});

describe('extractSlideElements (text + picture attribution)', () => {
    it('attributes text atoms to their enclosing SpContainer bounds', () => {
        const anchor = makeRect32Anchor(OFFICE_ART_CLIENT_ANCHOR, 100, 200, 500, 400);
        const textbox = makeContainer(OFFICE_ART_CLIENT_TEXTBOX, [
            makeTextCharsAtom('Hello shape')
        ]);
        const sp = makeContainer(OFFICE_ART_SP_CONTAINER, [anchor, textbox]);
        const slide = makeContainer(RT_SLIDE, [sp]);
        const records = parseRecords(slide, 0, slide.length);
        const slides = collectSlideRecords(records);
        const elements = extractSlideElements(slides[0], new Set());
        expect(elements).toHaveLength(1);
        const element = elements[0];
        expect(element.kind).toBe('text');
        if (element.kind === 'text') {
            expect(element.text).toBe('Hello shape');
            expect(element.bounds).toEqual({ x: 100, y: 200, width: 400, height: 200 });
        }
    });

    it('surfaces orphan text atoms with bounds: undefined', () => {
        // Text atom directly under the slide container — no SpContainer.
        const slide = makeContainer(RT_SLIDE, [makeTextCharsAtom('orphan title')]);
        const records = parseRecords(slide, 0, slide.length);
        const slides = collectSlideRecords(records);
        const elements = extractSlideElements(slides[0], new Set());
        expect(elements).toHaveLength(1);
        const element = elements[0];
        expect(element.kind).toBe('text');
        if (element.kind === 'text') {
            expect(element.text).toBe('orphan title');
            expect(element.bounds).toBeUndefined();
        }
    });

    it('emits a picture element when the OPT carries a BLIP id (opid 0x0104)', () => {
        const anchor = makeRect32Anchor(OFFICE_ART_CLIENT_ANCHOR, 0, 0, 200, 200);
        // opid 0x0104 with the high blip-id bit (0x4000) set, value = 1.
        const opt = makeOptRecord([makeOptProperty(0x0104 | 0x4000, 1)]);
        const sp = makeContainer(OFFICE_ART_SP_CONTAINER, [anchor, opt]);
        const slide = makeContainer(RT_SLIDE, [sp]);
        const records = parseRecords(slide, 0, slide.length);
        const slides = collectSlideRecords(records);
        const elements = extractSlideElements(slides[0], new Set([1]));
        expect(elements).toHaveLength(1);
        expect(elements[0].kind).toBe('picture');
        if (elements[0].kind === 'picture') {
            expect(elements[0].pictureId).toBe(1);
            expect(elements[0].bounds).toEqual({ x: 0, y: 0, width: 200, height: 200 });
        }
    });

    it('skips picture elements when the referenced BLIP id is not present', () => {
        const anchor = makeRect32Anchor(OFFICE_ART_CLIENT_ANCHOR, 0, 0, 200, 200);
        const opt = makeOptRecord([makeOptProperty(0x0104 | 0x4000, 42)]);
        const sp = makeContainer(OFFICE_ART_SP_CONTAINER, [anchor, opt]);
        const slide = makeContainer(RT_SLIDE, [sp]);
        const records = parseRecords(slide, 0, slide.length);
        const slides = collectSlideRecords(records);
        // Pass an empty set — BLIP id 42 isn't extractable.
        const elements = extractSlideElements(slides[0], new Set());
        expect(elements.filter((e) => e.kind === 'picture')).toHaveLength(0);
    });
});

describe('parsePptBuffer (end-to-end with #78 model)', () => {
    it('surfaces presentation metrics from the DocumentAtom', () => {
        const slide = makeContainer(RT_SLIDE, [makeTextCharsAtom('one')]);
        const docStream = makeContainer(RT_DOCUMENT, [
            makeDocumentAtom(5760, 4320),
            slide
        ]);
        const result = parsePptBuffer(buildPptCfb(docStream));
        expect(result.metrics.widthPx).toBe(960);
        expect(result.metrics.heightPx).toBe(720);
    });

    it('populates PptSlideModel.elements when shape bounds are extractable', () => {
        const anchor = makeRect32Anchor(OFFICE_ART_CLIENT_ANCHOR, 10, 20, 110, 120);
        const textbox = makeContainer(OFFICE_ART_CLIENT_TEXTBOX, [
            makeTextCharsAtom('shape text')
        ]);
        const sp = makeContainer(OFFICE_ART_SP_CONTAINER, [anchor, textbox]);
        const slide = makeContainer(RT_SLIDE, [sp]);
        const docStream = makeContainer(RT_DOCUMENT, [slide]);
        const result = parsePptBuffer(buildPptCfb(docStream));
        expect(result.slides[0].elements).toBeDefined();
        expect(result.slides[0].elements!.length).toBeGreaterThan(0);
        const element = result.slides[0].elements![0];
        if (element.kind === 'text') {
            expect(element.text).toBe('shape text');
            expect(element.bounds).toEqual({ x: 10, y: 20, width: 100, height: 100 });
        }
    });

    it('returns metrics + empty pictures map when no Pictures stream exists', () => {
        const slide = makeContainer(RT_SLIDE, [makeTextCharsAtom('plain')]);
        const docStream = makeContainer(RT_DOCUMENT, [slide]);
        const result = parsePptBuffer(buildPptCfb(docStream));
        expect(result.pictures.size).toBe(0);
        // Default metrics when DocumentAtom is missing.
        expect(result.metrics.widthPx).toBe(720);
        expect(result.metrics.heightPx).toBe(540);
    });

    it('preserves the text-only texts[] alongside any orphan element', () => {
        // Pure RT_Slide with a bare text atom — no OfficeArt wrapper.
        // The parser will surface the atom as an orphan element (bounds:
        // undefined) AND keep it in `texts[]` so the viewer's fallback
        // dispatch continues to work either way.
        const slide = makeContainer(RT_SLIDE, [makeTextCharsAtom('flat')]);
        const docStream = makeContainer(RT_DOCUMENT, [slide]);
        const result = parsePptBuffer(buildPptCfb(docStream));
        expect(result.slides[0].texts).toEqual(['flat']);
        // Orphan element carries no bounds — renderer should fall back
        // to a default position.
        if (result.slides[0].elements && result.slides[0].elements.length > 0) {
            const el = result.slides[0].elements[0];
            if (el.kind === 'text') {
                expect(el.bounds).toBeUndefined();
            }
        }
    });

    it('falls back to text-only when the document has zero RT_Slide containers', () => {
        // Recovery-mode path: no slides, no metrics surface from atoms.
        const docStream = makeContainer(RT_DOCUMENT, [
            makeTextCharsAtom('recovered title')
        ]);
        const result = parsePptBuffer(buildPptCfb(docStream));
        expect(result.totalSlides).toBe(1);
        expect(result.slides[0].texts).toContain('recovered title');
        expect(result.slides[0].elements).toBeUndefined();
    });

    it('does not throw when the PowerPoint Document stream is empty', () => {
        const result = parsePptBuffer(buildPptCfb(new Uint8Array(0)));
        expect(result.totalSlides).toBe(0);
        expect(result.metrics).toBeDefined();
        expect(result.pictures.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Synthetic image builders. Just barely valid enough that the parser's
// PNG / JPEG / BMP scanners accept them — none of these decode to a real
// pixel grid, but they exercise the framing rules.
// ---------------------------------------------------------------------------

function buildMinimalPng(): Uint8Array {
    // 8-byte signature + IHDR (13 data bytes) + IEND (0 data bytes).
    // Each chunk = u32 length BE + 4-char type + data + u32 CRC BE.
    // We use a fake CRC of 0x00000000 — `findPngEnd` doesn't validate.
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = new Uint8Array(4 + 4 + 13 + 4);
    const ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, 13, false);
    ihdr.set([0x49, 0x48, 0x44, 0x52], 4); // 'IHDR'
    // 13 bytes of data: width(4), height(4), bitDepth(1), colorType(1),
    // compression(1), filter(1), interlace(1). We zero them — content
    // doesn't matter for the framing test.
    // CRC trails at bytes 21..24 — left as zero.
    const iend = new Uint8Array(4 + 4 + 0 + 4);
    const iendView = new DataView(iend.buffer);
    iendView.setUint32(0, 0, false);
    iend.set([0x49, 0x45, 0x4e, 0x44], 4); // 'IEND'
    const out = new Uint8Array(sig.length + ihdr.length + iend.length);
    out.set(sig, 0);
    out.set(ihdr, sig.length);
    out.set(iend, sig.length + ihdr.length);
    return out;
}

function buildMinimalJpeg(): Uint8Array {
    // FF D8 FF (SOI + APP0 marker prefix) + APP0 segment + EOI.
    // APP0 must start with FFE0 + length(BE, 2 bytes) + "JFIF\0" + version + etc.
    // We build the minimum that getUint16 BE in findJpegEnd will accept:
    // FFD8 FFE0 0010 4A 46 49 46 00 01 01 00 00 01 00 01 00 00 FFD9.
    return new Uint8Array([
        0xff, 0xd8, // SOI
        0xff, 0xe0, // APP0
        0x00, 0x10, // length = 16 (includes the 2 length bytes)
        0x4a, 0x46, 0x49, 0x46, 0x00, // 'JFIF\0'
        0x01, 0x01, // version
        0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // density + thumbnail
        0xff, 0xd9 // EOI
    ]);
}

function buildMinimalBmp(byteSize: number): Uint8Array {
    // BMP file header: 'BM' + u32 fileSize (LE) + u16 reserved + u16
    // reserved + u32 dataOffset. We don't need a valid DIB body — just
    // the 'BM' magic and a length field that the scanner reads.
    const out = new Uint8Array(byteSize);
    out[0] = 0x42; // 'B'
    out[1] = 0x4d; // 'M'
    const view = new DataView(out.buffer);
    view.setUint32(2, byteSize, true);
    return out;
}

// ---------------------------------------------------------------------------
// Issue #79: extractLooseTextFromCfb — best-effort CFB loose-text recovery.
// ---------------------------------------------------------------------------

describe('extractLooseTextFromCfb (issue #79)', () => {
    it('recovers text atoms when the document contains no RT_Slide containers', () => {
        // Document body has only loose text atoms — no RT_Slide.
        const docStream = makeContainer(RT_DOCUMENT, [
            makeTextCharsAtom('recovered one'),
            makeTextCharsAtom('recovered two')
        ]);
        const result = extractLooseTextFromCfb(buildPptCfb(docStream));
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('recovered one');
        expect(result[0]).toContain('recovered two');
    });

    it('recovers text from inside legitimate slide containers too', () => {
        // The helper is "loose" — it does not care whether the text is
        // wrapped in a slide container. This mirrors the production
        // contract: we re-run it whenever the primary parser came back
        // empty *or* with no usable per-slide text.
        const slide = makeContainer(RT_SLIDE, [
            makeTextCharsAtom('slide a text')
        ]);
        const docStream = makeContainer(RT_DOCUMENT, [slide]);
        const result = extractLooseTextFromCfb(buildPptCfb(docStream));
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('slide a text');
    });

    it('returns [] for a corrupted buffer rather than throwing', () => {
        // 64 zero bytes — fails the CFB magic check.
        const garbage = new Uint8Array(64);
        expect(() => extractLooseTextFromCfb(garbage)).not.toThrow();
        expect(extractLooseTextFromCfb(garbage)).toEqual([]);
    });

    it('returns [] for a non-CFB buffer (zip / PDF / etc.)', () => {
        const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
        expect(extractLooseTextFromCfb(zipMagic)).toEqual([]);
    });

    it('returns [] when the document stream is empty', () => {
        const result = extractLooseTextFromCfb(buildPptCfb(new Uint8Array(0)));
        expect(result).toEqual([]);
    });

    it('returns [] when the CFB has no decodable text atoms', () => {
        // A document container with only a non-text atom — nothing for
        // the loose scan to recover.
        const noise = makeRecord(0x1234, new Uint8Array([1, 2, 3, 4]));
        const docStream = makeContainer(RT_DOCUMENT, [noise]);
        const result = extractLooseTextFromCfb(buildPptCfb(docStream));
        expect(result).toEqual([]);
    });

    it('handles a null / undefined input defensively', () => {
        expect(extractLooseTextFromCfb(null as unknown as Uint8Array)).toEqual([]);
        expect(extractLooseTextFromCfb(undefined as unknown as Uint8Array)).toEqual([]);
    });
});
