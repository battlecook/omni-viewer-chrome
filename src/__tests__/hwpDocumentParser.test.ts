/**
 * Unit tests for the HWPX parser ported in issue #54.
 *
 * The parser is regex-driven over HWPX section XML; we exercise it with
 * inline fixtures so no real `.hwpx` files have to ship under
 * `__fixtures__/`. Each fixture mirrors the shape an HWPX writer would
 * emit (namespace prefixes, attribute ordering, `<hp:t>` wrappers).
 *
 * Coverage:
 *   - paragraph extraction (text + runs)
 *   - per-run formatting (bold / italic / size / color)
 *   - paragraph alignment
 *   - tables (rows / cells / colSpan / rowSpan)
 *   - empty / whitespace-only sections
 *   - top-level `parseHwpxBuffer` with a stub JSZip
 *   - dispatch helper `isHwpxFile`
 */

import {
    parseHwpxBuffer,
    parseHwpxSectionXml,
    JsZipConstructor,
} from '../utils/hwpDocumentParser';
import {
    HwpLayoutBlock,
    HwpLayoutParagraph,
    HwpLayoutTableBlock,
} from '../utils/hwpDocumentTypes';
import { isHwpxFile } from '../templates/hwp/js/hwpViewerMain';

const SECTION_PARAGRAPHS = `
<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="hs" xmlns:hp="hp">
    <hp:p align="center">
        <hp:run fontSize="2400" textColor="#ff0000">
            <hp:t>Hello HWPX</hp:t>
        </hp:run>
    </hp:p>
    <hp:p>
        <hp:run bold="1" italic="1">
            <hp:t>Bold italic</hp:t>
        </hp:run>
        <hp:run>
            <hp:t> normal</hp:t>
        </hp:run>
    </hp:p>
</hs:sec>
`;

const SECTION_TABLE = `
<hs:sec xmlns:hs="hs" xmlns:hp="hp">
    <hp:p>
        <hp:run><hp:t>Before table</hp:t></hp:run>
    </hp:p>
    <hp:tbl>
        <hp:tr>
            <hp:tc>
                <hp:p><hp:run><hp:t>R1C1</hp:t></hp:run></hp:p>
            </hp:tc>
            <hp:tc colSpan="2">
                <hp:p><hp:run><hp:t>R1C2 spans</hp:t></hp:run></hp:p>
            </hp:tc>
        </hp:tr>
        <hp:tr>
            <hp:tc rowSpan="2">
                <hp:p><hp:run><hp:t>R2C1 row span</hp:t></hp:run></hp:p>
            </hp:tc>
            <hp:tc>
                <hp:p><hp:run><hp:t>R2C2</hp:t></hp:run></hp:p>
            </hp:tc>
            <hp:tc>
                <hp:p><hp:run><hp:t>R2C3</hp:t></hp:run></hp:p>
            </hp:tc>
        </hp:tr>
    </hp:tbl>
    <hp:p>
        <hp:run><hp:t>After table</hp:t></hp:run>
    </hp:p>
</hs:sec>
`;

const SECTION_EMPTY = `
<hs:sec xmlns:hs="hs" xmlns:hp="hp">
    <hp:p>
        <hp:run><hp:t>   </hp:t></hp:run>
    </hp:p>
</hs:sec>
`;

const SECTION_ENTITIES = `
<hs:sec xmlns:hs="hs" xmlns:hp="hp">
    <hp:p>
        <hp:run><hp:t>5 &lt; 10 &amp; &quot;ok&quot;</hp:t></hp:run>
    </hp:p>
</hs:sec>
`;

function paragraphsOf(blocks: HwpLayoutBlock[]): HwpLayoutParagraph[] {
    return blocks.filter((b): b is HwpLayoutParagraph => b.kind === 'paragraph');
}

function tablesOf(blocks: HwpLayoutBlock[]): HwpLayoutTableBlock[] {
    return blocks.filter((b): b is HwpLayoutTableBlock => b.kind === 'table');
}

describe('parseHwpxSectionXml — paragraphs', () => {
    it('extracts text from each paragraph run', () => {
        const page = parseHwpxSectionXml(SECTION_PARAGRAPHS, 0);
        const paragraphs = paragraphsOf(page.blocks);
        expect(paragraphs).toHaveLength(2);
        expect(paragraphs[0].runs.map((r) => r.text).join('')).toBe('Hello HWPX');
        expect(paragraphs[1].runs.map((r) => r.text).join('')).toBe(
            'Bold italic normal'
        );
    });

    it('captures alignment from paragraph attributes', () => {
        const page = parseHwpxSectionXml(SECTION_PARAGRAPHS, 0);
        const paragraphs = paragraphsOf(page.blocks);
        expect(paragraphs[0].align).toBe('center');
        expect(paragraphs[1].align).toBe('left');
    });

    it('captures bold and italic on individual runs', () => {
        const page = parseHwpxSectionXml(SECTION_PARAGRAPHS, 0);
        const second = paragraphsOf(page.blocks)[1];
        expect(second.runs[0].fontWeight).toBe('700');
        expect(second.runs[0].fontStyle).toBe('italic');
        expect(second.runs[1].fontWeight).toBeUndefined();
        expect(second.runs[1].fontStyle).toBeUndefined();
    });

    it('converts HWPUNIT font size to points and reads color', () => {
        const page = parseHwpxSectionXml(SECTION_PARAGRAPHS, 0);
        const first = paragraphsOf(page.blocks)[0];
        expect(first.runs[0].fontSizePt).toBeGreaterThan(0);
        // 2400 / 7200 * 72 = 24 pt
        expect(first.runs[0].fontSizePt).toBeCloseTo(24, 1);
        expect(first.runs[0].color).toBe('#ff0000');
    });

    it('decodes XML entities inside text', () => {
        const page = parseHwpxSectionXml(SECTION_ENTITIES, 0);
        const paragraphs = paragraphsOf(page.blocks);
        expect(paragraphs[0].runs[0].text).toBe('5 < 10 & "ok"');
    });

    it('falls back to a single empty paragraph when section has no real text', () => {
        const page = parseHwpxSectionXml(SECTION_EMPTY, 0);
        expect(page.blocks).toHaveLength(1);
        const empty = page.blocks[0] as HwpLayoutParagraph;
        expect(empty.kind).toBe('paragraph');
        expect(empty.runs).toEqual([]);
    });

    it('assigns stable ids per paragraph', () => {
        const page = parseHwpxSectionXml(SECTION_PARAGRAPHS, 0);
        const paragraphs = paragraphsOf(page.blocks);
        expect(paragraphs[0].id).toBe('hwpx-p-1-1');
        expect(paragraphs[1].id).toBe('hwpx-p-1-2');
    });
});

describe('parseHwpxSectionXml — tables', () => {
    it('extracts a table with rows and cells', () => {
        const page = parseHwpxSectionXml(SECTION_TABLE, 0);
        const tables = tablesOf(page.blocks);
        expect(tables).toHaveLength(1);
        const table = tables[0];
        expect(table.rows).toHaveLength(2);
        expect(table.rows[0].cells).toHaveLength(2);
        expect(table.rows[1].cells).toHaveLength(3);
    });

    it('reads colSpan and rowSpan from cell attributes', () => {
        const page = parseHwpxSectionXml(SECTION_TABLE, 0);
        const table = tablesOf(page.blocks)[0];
        expect(table.rows[0].cells[1].colSpan).toBe(2);
        expect(table.rows[1].cells[0].rowSpan).toBe(2);
        // Default is 1 when no attribute is present.
        expect(table.rows[0].cells[0].colSpan).toBe(1);
        expect(table.rows[0].cells[0].rowSpan).toBe(1);
    });

    it('renders cell text through the paragraph pipeline', () => {
        const page = parseHwpxSectionXml(SECTION_TABLE, 0);
        const table = tablesOf(page.blocks)[0];
        const r1c1 = table.rows[0].cells[0];
        expect(r1c1.paragraphs).toHaveLength(1);
        expect(r1c1.paragraphs[0].runs.map((r) => r.text).join('')).toBe('R1C1');
        const r1c2 = table.rows[0].cells[1];
        expect(r1c2.paragraphs[0].runs.map((r) => r.text).join('')).toBe('R1C2 spans');
    });

    it('preserves source order between paragraphs and tables', () => {
        const page = parseHwpxSectionXml(SECTION_TABLE, 0);
        const kinds = page.blocks.map((b) => b.kind);
        expect(kinds).toEqual(['paragraph', 'table', 'paragraph']);
        const before = page.blocks[0] as HwpLayoutParagraph;
        const after = page.blocks[2] as HwpLayoutParagraph;
        expect(before.runs[0].text).toBe('Before table');
        expect(after.runs[0].text).toBe('After table');
    });

    it('does not double-count table cells as top-level paragraphs', () => {
        const page = parseHwpxSectionXml(SECTION_TABLE, 0);
        const topParagraphs = paragraphsOf(page.blocks);
        // Only the two outer paragraphs ("Before table" / "After table")
        // should appear at the top level — the cell paragraphs live
        // inside the table.
        expect(topParagraphs).toHaveLength(2);
        const texts = topParagraphs
            .map((p) => p.runs.map((r) => r.text).join(''))
            .sort();
        expect(texts).toEqual(['After table', 'Before table']);
    });
});

describe('parseHwpxBuffer — top-level entry', () => {
    /**
     * Stub JSZip namespace that mimics the surface our parser uses:
     * `loadAsync()` returns an archive whose `files` is a record of
     * `{ async('text') }` promises. We can drive it with arbitrary
     * section XML without bundling a real ZIP.
     */
    function makeStubJsZip(sections: Record<string, string>): JsZipConstructor {
        const files: Record<string, { name: string; async(t: 'text'): Promise<string> }> = {};
        for (const [name, xml] of Object.entries(sections)) {
            files[name] = { name, async: () => Promise.resolve(xml) };
        }
        const stub = function StubJSZip() {
            return { files };
        } as unknown as JsZipConstructor;
        (stub as unknown as { loadAsync: (b: ArrayBuffer | Uint8Array) => Promise<{ files: typeof files }> }).loadAsync =
            () => Promise.resolve({ files });
        return stub;
    }

    it('reads section*.xml entries in numeric order', async () => {
        const stub = makeStubJsZip({
            'Contents/section10.xml': SECTION_PARAGRAPHS,
            'Contents/section2.xml': SECTION_TABLE,
            'Contents/section1.xml': SECTION_PARAGRAPHS,
        });
        const document = await parseHwpxBuffer(new Uint8Array([0]), stub, 'doc.hwpx');
        expect(document.format).toBe('hwpx');
        expect(document.fileName).toBe('doc.hwpx');
        expect(document.pages).toHaveLength(3);
        expect(document.pages[0].sectionIndex).toBe(1);
        // section2 (table) sits between section1 and section10 even
        // though lexicographic sort would otherwise put section10
        // ahead of section2.
        expect(document.pages[1].blocks.some((b) => b.kind === 'table')).toBe(true);
    });

    it('records a warning when no section XML is present', async () => {
        const stub = makeStubJsZip({});
        const document = await parseHwpxBuffer(new Uint8Array([0]), stub, 'empty.hwpx');
        expect(document.pages).toHaveLength(1);
        expect(document.warnings.length).toBeGreaterThan(0);
    });

    it('skips zip entries whose name does not match the section pattern', async () => {
        const stub = makeStubJsZip({
            'Contents/section1.xml': SECTION_PARAGRAPHS,
            'Contents/header.xml': '<header/>',
            'BinData/image1.png': 'binary',
        });
        const document = await parseHwpxBuffer(new Uint8Array([0]), stub, 'doc.hwpx');
        expect(document.pages).toHaveLength(1);
    });
});

describe('isHwpxFile dispatch', () => {
    it('returns true for .hwpx (case-insensitive)', () => {
        expect(isHwpxFile('foo.hwpx')).toBe(true);
        expect(isHwpxFile('Foo.HWPX')).toBe(true);
    });

    it('returns false for .hwp and other extensions', () => {
        expect(isHwpxFile('foo.hwp')).toBe(false);
        expect(isHwpxFile('foo.docx')).toBe(false);
        expect(isHwpxFile('foo')).toBe(false);
    });
});
