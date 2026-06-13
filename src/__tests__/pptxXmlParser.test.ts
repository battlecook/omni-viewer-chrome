// Parser-only unit tests for the Chrome PPTX XML parser (issue #46).
//
// These tests intentionally avoid loading the JSZip vendor bundle.
// `PptxXmlParser.parseZip` accepts a duck-typed `PptxZip`, so we build a
// fixture-driven `FakeZip` from a map of paths to UTF-8 strings. Binary
// entries (pictures) can also be supplied as Uint8Arrays — only the
// renderer reads those, but the parser surfaces the picture target so we
// validate it.

import {
    PptxXmlParser,
    countPptxRenderableShapes,
    extractPptxFallbackText,
    type PptxZip,
    type PptxZipFile,
    type PptxShape
} from '../utils/pptxXmlParser';

// ---------------------------------------------------------------------------
// FakeZip helper
// ---------------------------------------------------------------------------

interface FakeFile {
    text?: string;
    bytes?: Uint8Array;
}

function makeFakeFile(entry: FakeFile): PptxZipFile {
    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async(type: 'text' | 'uint8array' | 'base64'): Promise<any> {
            if (type === 'text') {
                return entry.text ?? '';
            }
            if (type === 'uint8array') {
                return entry.bytes ?? new Uint8Array();
            }
            if (type === 'base64') {
                if (!entry.bytes) return '';
                return Buffer.from(entry.bytes).toString('base64');
            }
            throw new Error(`unsupported async type ${type}`);
        }
    };
}

function makeFakeZip(entries: Record<string, FakeFile | string>): PptxZip {
    const normalized: Record<string, FakeFile> = {};
    for (const [k, v] of Object.entries(entries)) {
        normalized[k] = typeof v === 'string' ? { text: v } : v;
    }
    return {
        file(path: string): PptxZipFile | null {
            const e = normalized[path];
            return e ? makeFakeFile(e) : null;
        },
        files: normalized
    };
}

// ---------------------------------------------------------------------------
// Common XML fixture builders
// ---------------------------------------------------------------------------

const NS_ATTRS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function presentationXml(slideRelId = 'rId2', cx = 9144000, cy = 6858000): string {
    return `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS_ATTRS}>
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst><p:sldId id="256" r:id="${slideRelId}"/></p:sldIdLst>
  <p:sldSz cx="${cx}" cy="${cy}"/>
</p:presentation>`;
}

function presentationRelsXml(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`;
}

function slideRelsXml(includeMedia = false): string {
    const media = includeMedia
        ? '<Relationship Id="rImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>'
        : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  ${media}
</Relationships>`;
}

function layoutRelsXml(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

function masterRelsXml(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

const MASTER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<p:sldMaster ${NS_ATTRS}>
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
</p:sldMaster>`;

const LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<p:sldLayout ${NS_ATTRS} type="title">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`;

const THEME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test Theme">
  <a:themeElements>
    <a:clrScheme name="Test">
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk1><a:srgbClr val="000000"/></a:dk1>
      <a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
      <a:dk2><a:srgbClr val="222222"/></a:dk2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
    </a:clrScheme>
  </a:themeElements>
</a:theme>`;

function buildSlideXml(spTreeBody: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS_ATTRS}>
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${spTreeBody}
    </p:spTree>
  </p:cSld>
</p:sld>`;
}

function buildBaseFixture(slideBody: string, extras: Record<string, FakeFile | string> = {}): PptxZip {
    return makeFakeZip({
        'ppt/presentation.xml': presentationXml(),
        'ppt/_rels/presentation.xml.rels': presentationRelsXml(),
        'ppt/slides/slide1.xml': buildSlideXml(slideBody),
        'ppt/slides/_rels/slide1.xml.rels': slideRelsXml(),
        'ppt/slideLayouts/slideLayout1.xml': LAYOUT_XML,
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels': layoutRelsXml(),
        'ppt/slideMasters/slideMaster1.xml': MASTER_XML,
        'ppt/slideMasters/_rels/slideMaster1.xml.rels': masterRelsXml(),
        'ppt/theme/theme1.xml': THEME_XML,
        ...extras
    });
}

// ---------------------------------------------------------------------------
// Pure helper tests (no zip)
// ---------------------------------------------------------------------------

describe('PptxXmlParser primitives', () => {
    it('decodes XML entities', () => {
        expect(PptxXmlParser.decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot;'))
            .toBe('a & b <c> "d"');
    });

    it('reads attributes from a tag string', () => {
        const tag = '<a:off x="100" y="200"/>';
        expect(PptxXmlParser.getAttr(tag, 'x')).toBe('100');
        expect(PptxXmlParser.getAttr(tag, 'y')).toBe('200');
        expect(PptxXmlParser.getAttr(tag, 'z')).toBeUndefined();
    });

    it('supports single-quoted attributes', () => {
        const tag = "<p:ph type='title' idx='0'/>";
        expect(PptxXmlParser.getAttr(tag, 'type')).toBe('title');
        expect(PptxXmlParser.getAttr(tag, 'idx')).toBe('0');
    });

    it('converts EMU to pixels via the standard 1px = 9525 EMU ratio', () => {
        expect(PptxXmlParser.emuToPx(914400)).toBe(96); // 1 inch
        expect(PptxXmlParser.emuToPx(0)).toBe(0);
    });

    it('extracts a balanced tag (self-closing)', () => {
        const xml = '<root><a:off x="1" y="2"/></root>';
        const block = PptxXmlParser.extractBalancedTag(xml, 'a:off', xml.indexOf('<a:off'));
        expect(block).not.toBeNull();
        expect(block?.content).toBe('<a:off x="1" y="2"/>');
    });

    it('extracts a balanced tag with nested same-named children', () => {
        const xml = '<a:p><a:r>1</a:r><a:p>nested</a:p></a:p>';
        const block = PptxXmlParser.extractBalancedTag(xml, 'a:p', 0);
        expect(block).not.toBeNull();
        // Top-level `<a:p>` block must end at the outer `</a:p>` even though
        // a same-named child is nested inside.
        expect(block?.innerContent).toContain('<a:p>nested</a:p>');
    });

    it('extracts the first matching tag block by name', () => {
        const xml = '<wrap><a:off x="5"/><a:ext cx="6"/></wrap>';
        expect(PptxXmlParser.extractTagBlock(xml, 'a:off')).toBe('<a:off x="5"/>');
        expect(PptxXmlParser.extractTagBlock(xml, 'a:ext')).toBe('<a:ext cx="6"/>');
        expect(PptxXmlParser.extractTagBlock(xml, 'a:missing')).toBe('');
    });

    it('finds the next opening tag index, skipping similar-prefix tags', () => {
        const xml = '<wrap><a:offFoo/><a:off x="1"/></wrap>';
        const idx = PptxXmlParser.findNextTagIndex(xml, 'a:off', 0);
        expect(xml.slice(idx).startsWith('<a:off x="1"')).toBe(true);
    });

    it('parses geometry from <a:xfrm>', () => {
        const xml = '<p:spPr><a:xfrm rot="2700000"><a:off x="914400" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm></p:spPr>';
        const geom = PptxXmlParser.parseGeometry(xml);
        expect(geom).toEqual({
            x: 96,
            y: 0,
            width: 192,
            height: 96,
            rotateDeg: 45,
            flipH: undefined,
            flipV: undefined
        });
    });

    it('returns null geometry when both extents are zero', () => {
        const xml = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>';
        expect(PptxXmlParser.parseGeometry(xml)).toBeNull();
    });

    it('detects title shapes by ph type and by name', () => {
        expect(PptxXmlParser.isTitleShape('<p:ph type="title"/>')).toBe(true);
        expect(PptxXmlParser.isTitleShape('<p:ph type="ctrTitle"/>')).toBe(true);
        expect(PptxXmlParser.isTitleShape('<p:cNvPr id="2" name="Title 1"/>')).toBe(true);
        expect(PptxXmlParser.isTitleShape('<p:cNvPr id="2" name="Subtitle 1"/>')).toBe(false);
        expect(PptxXmlParser.isTitleShape('<p:cNvPr id="2" name="Body 1"/>')).toBe(false);
    });

    it('builds placeholder keys for known types', () => {
        expect(PptxXmlParser.getPlaceholderKey('<p:ph type="title"/>')).toBe('type:title');
        expect(PptxXmlParser.getPlaceholderKey('<p:ph type="ctrTitle"/>')).toBe('type:title');
        expect(PptxXmlParser.getPlaceholderKey('<p:ph type="body"/>')).toBe('type:body');
        expect(PptxXmlParser.getPlaceholderKey('<p:ph type="subTitle"/>')).toBe('type:body');
        // No <p:ph> at all → no key.
        expect(PptxXmlParser.getPlaceholderKey('<p:cNvPr id="2"/>')).toBeUndefined();
    });

    it('flags placeholder prompt text in English and Korean', () => {
        expect(PptxXmlParser.isPlaceholderPromptText('Click to edit Master title style')).toBe(true);
        expect(PptxXmlParser.isPlaceholderPromptText('Edit Master text styles')).toBe(true);
        expect(PptxXmlParser.isPlaceholderPromptText('Second level')).toBe(true);
        expect(PptxXmlParser.isPlaceholderPromptText('마스터 텍스트 스타일을 편집합니다')).toBe(true);
        expect(PptxXmlParser.isPlaceholderPromptText('둘째 수준')).toBe(true);
        expect(PptxXmlParser.isPlaceholderPromptText('Real slide content')).toBe(false);
    });

    it('parses theme srgb colours and falls back to defaults', () => {
        const theme = PptxXmlParser.parseTheme(THEME_XML);
        expect(theme.colors.lt1).toBe('#ffffff');
        expect(theme.colors.dk1).toBe('#000000');
        expect(theme.colors.accent1).toBe('#4472c4');
        // Empty input returns the static default scheme.
        const fallback = PptxXmlParser.parseTheme('');
        expect(fallback.colors.lt1).toBe('#ffffff');
        expect(fallback.colors.accent2).toBe('#ed7d31');
    });

    it('resolves srgb / scheme / mapped colours via the colour context', () => {
        const theme = PptxXmlParser.parseTheme(THEME_XML);
        const ctx = PptxXmlParser.buildColorContext(theme, MASTER_XML, '', '');
        expect(PptxXmlParser.extractColorFromXml('<a:srgbClr val="FF0000"/>', ctx)).toBe('#ff0000');
        expect(PptxXmlParser.extractColorFromXml('<a:schemeClr val="accent1"/>', ctx)).toBe('#4472c4');
        // tx1 maps to dk1 via the master clrMap.
        expect(PptxXmlParser.extractColorFromXml('<a:schemeClr val="tx1"/>', ctx)).toBe('#000000');
        expect(PptxXmlParser.extractColorFromXml('', ctx)).toBeUndefined();
    });

    it('resolves rels paths relative to the part path', () => {
        expect(PptxXmlParser.toRelsPath('ppt/slides/slide1.xml')).toBe('ppt/slides/_rels/slide1.xml.rels');
        expect(PptxXmlParser.toRelsPath('ppt/presentation.xml')).toBe('ppt/_rels/presentation.xml.rels');
    });

    it('resolves relationship targets through .. segments', () => {
        expect(PptxXmlParser.resolvePath('ppt/slides/slide1.xml', '../media/image1.png'))
            .toBe('ppt/media/image1.png');
        expect(PptxXmlParser.resolvePath('ppt/slides/slide1.xml', '../slideLayouts/slideLayout1.xml'))
            .toBe('ppt/slideLayouts/slideLayout1.xml');
        expect(PptxXmlParser.resolvePath('ppt/presentation.xml', '/ppt/media/image1.png'))
            .toBe('ppt/media/image1.png');
    });

    it('maps file extensions to MIME types', () => {
        expect(PptxXmlParser.getMimeTypeByExtension('image1.png')).toBe('image/png');
        expect(PptxXmlParser.getMimeTypeByExtension('image1.JPG')).toBe('image/jpeg');
        expect(PptxXmlParser.getMimeTypeByExtension('foo.unknown')).toBe('application/octet-stream');
    });
});

// ---------------------------------------------------------------------------
// extractTextParagraphs (works on a plain shape XML string, no zip needed)
// ---------------------------------------------------------------------------

describe('PptxXmlParser text extraction', () => {
    const ctx = PptxXmlParser.buildColorContext(
        PptxXmlParser.parseTheme(THEME_XML),
        MASTER_XML,
        '',
        ''
    );

    it('extracts plain paragraph text with default level 0', () => {
        const xml = '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr/><a:t>Hello</a:t></a:r></a:p></p:txBody>';
        const ps = PptxXmlParser.extractTextParagraphs(xml, ctx);
        expect(ps).toHaveLength(1);
        expect(ps[0].text).toBe('Hello');
        expect(ps[0].level).toBe(0);
    });

    it('respects pPr lvl for paragraph indentation level', () => {
        const xml = '<p:txBody><a:p><a:pPr lvl="2"/><a:r><a:t>Indented</a:t></a:r></a:p></p:txBody>';
        const ps = PptxXmlParser.extractTextParagraphs(xml, ctx);
        expect(ps[0].level).toBe(2);
    });

    it('decodes XML entities inside <a:t>', () => {
        const xml = '<p:txBody><a:p><a:r><a:t>A &amp; B</a:t></a:r></a:p></p:txBody>';
        const ps = PptxXmlParser.extractTextParagraphs(xml, ctx);
        expect(ps[0].text).toBe('A & B');
    });

    it('captures run-level styling (bold / italic / size / color)', () => {
        const xml = '<p:txBody><a:p>'
            + '<a:r><a:rPr sz="2400" b="1" i="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>Stylish</a:t></a:r>'
            + '</a:p></p:txBody>';
        const ps = PptxXmlParser.extractTextParagraphs(xml, ctx);
        expect(ps[0].runs).toBeDefined();
        const run = ps[0].runs?.[0];
        expect(run?.text).toBe('Stylish');
        expect(run?.bold).toBe(true);
        expect(run?.italic).toBe(true);
        // 24pt -> 24 * 1.333 ≈ 32px (parser rounds).
        expect(run?.fontSizePx).toBe(32);
        expect(run?.color).toBe('#ff0000');
    });

    it('joins multiple runs into the same paragraph', () => {
        const xml = '<p:txBody><a:p>'
            + '<a:r><a:t>Hello </a:t></a:r>'
            + '<a:r><a:t>world</a:t></a:r>'
            + '</a:p></p:txBody>';
        const ps = PptxXmlParser.extractTextParagraphs(xml, ctx);
        expect(ps[0].text).toBe('Hello world');
        expect(ps[0].runs).toHaveLength(2);
    });

    it('skips empty paragraphs (no runs / whitespace only)', () => {
        const xml = '<p:txBody>'
            + '<a:p><a:r><a:t>One</a:t></a:r></a:p>'
            + '<a:p><a:endParaRPr/></a:p>'
            + '<a:p><a:r><a:t>   </a:t></a:r></a:p>'
            + '</p:txBody>';
        const ps = PptxXmlParser.extractTextParagraphs(xml, ctx);
        expect(ps).toHaveLength(1);
        expect(ps[0].text).toBe('One');
    });

    it('detects bullets via <a:buChar> and clears them with <a:buNone>', () => {
        const bulleted = '<p:txBody><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>Bulleted</a:t></a:r></a:p></p:txBody>';
        const noBullet = '<p:txBody><a:p><a:pPr><a:buNone/><a:buChar char="•"/></a:pPr><a:r><a:t>NoBullet</a:t></a:r></a:p></p:txBody>';
        expect(PptxXmlParser.extractTextParagraphs(bulleted, ctx)[0].bullet).toBe(true);
        expect(PptxXmlParser.extractTextParagraphs(noBullet, ctx)[0].bullet).toBe(false);
    });

    it('captures paragraph alignment via pPr algn attribute', () => {
        const xml = '<p:txBody><a:p><a:pPr algn="ctr"/><a:r><a:t>Centered</a:t></a:r></a:p></p:txBody>';
        expect(PptxXmlParser.extractTextParagraphs(xml, ctx)[0].align).toBe('ctr');
    });
});

// ---------------------------------------------------------------------------
// Placeholder inheritance helper tests
// ---------------------------------------------------------------------------

describe('PptxXmlParser placeholder inheritance', () => {
    const baseShape = (overrides: Partial<PptxShape>): PptxShape => ({
        kind: 'placeholder',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        zIndex: 0,
        sourcePriority: 1,
        ...overrides
    });

    it('takes the slide-level paragraphs over the master/layout', () => {
        const masterPlaceholder = baseShape({
            kind: 'placeholder',
            placeholderKey: 'type:title',
            sourcePriority: 1
        });
        const layoutPlaceholder = baseShape({
            kind: 'text',
            placeholderKey: 'type:title',
            sourcePriority: 2,
            paragraphs: [{ text: 'Layout title prompt', level: 0 }]
        });
        const slidePlaceholder = baseShape({
            kind: 'text',
            placeholderKey: 'type:title',
            sourcePriority: 3,
            paragraphs: [{ text: 'Real slide title', level: 0 }],
            isTitle: true
        });
        const merged = PptxXmlParser.mergeWithPlaceholderInheritance([
            masterPlaceholder,
            layoutPlaceholder,
            slidePlaceholder
        ]);
        const titleShapes = merged.filter((s) => s.placeholderKey === 'type:title');
        expect(titleShapes).toHaveLength(1);
        expect(titleShapes[0].paragraphs?.[0].text).toBe('Real slide title');
        expect(titleShapes[0].isTitle).toBe(true);
    });

    it('keeps non-placeholder shapes alongside merged placeholders', () => {
        const free = baseShape({ kind: 'text', sourcePriority: 3, paragraphs: [{ text: 'Free', level: 0 }] });
        const slidePh = baseShape({
            kind: 'text',
            placeholderKey: 'type:body',
            sourcePriority: 3,
            paragraphs: [{ text: 'Body', level: 0 }]
        });
        const merged = PptxXmlParser.mergeWithPlaceholderInheritance([free, slidePh]);
        expect(merged).toHaveLength(2);
        const texts = merged.map((s) => s.paragraphs?.[0]?.text);
        expect(texts).toContain('Free');
        expect(texts).toContain('Body');
    });

    it('reassigns sequential zIndex values after merging', () => {
        const a = baseShape({ kind: 'text', sourcePriority: 3, paragraphs: [{ text: 'A', level: 0 }] });
        const b = baseShape({ kind: 'text', sourcePriority: 3, paragraphs: [{ text: 'B', level: 0 }] });
        const c = baseShape({ kind: 'text', sourcePriority: 3, paragraphs: [{ text: 'C', level: 0 }] });
        const merged = PptxXmlParser.mergeWithPlaceholderInheritance([a, b, c]);
        const zs = merged.map((s) => s.zIndex);
        expect(zs).toEqual([0, 1, 2]);
    });
});

// ---------------------------------------------------------------------------
// End-to-end zip parsing tests (FakeZip with full PPTX skeleton)
// ---------------------------------------------------------------------------

describe('PptxXmlParser.parseZip', () => {
    it('parses a minimal slide with a single text shape', async () => {
        const zip = buildBaseFixture(`
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="600000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Deck Title</a:t></a:r></a:p></p:txBody>
      </p:sp>`);
        const doc = await PptxXmlParser.parseZip(zip);
        expect(doc.totalSlides).toBe(1);
        const slide = doc.slides[0];
        expect(slide.shapes).toHaveLength(1);
        expect(slide.shapes[0].kind).toBe('text');
        expect(slide.shapes[0].isTitle).toBe(true);
        expect(slide.shapes[0].paragraphs?.[0].text).toBe('Deck Title');
    });

    it('uses presentation slide size in pixels (1px = 9525 EMU)', async () => {
        const zip = buildBaseFixture('');
        const doc = await PptxXmlParser.parseZip(zip);
        // 9144000 / 9525 = 960; 6858000 / 9525 = 720
        expect(doc.slides[0].widthPx).toBe(960);
        expect(doc.slides[0].heightPx).toBe(720);
    });

    it('falls back to 1280x720 when sldSz is missing', async () => {
        const zip = makeFakeZip({
            'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS_ATTRS}>
                <p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
            'ppt/_rels/presentation.xml.rels': presentationRelsXml(),
            'ppt/slides/slide1.xml': buildSlideXml(''),
            'ppt/slides/_rels/slide1.xml.rels': slideRelsXml(),
            'ppt/slideLayouts/slideLayout1.xml': LAYOUT_XML,
            'ppt/slideLayouts/_rels/slideLayout1.xml.rels': layoutRelsXml(),
            'ppt/slideMasters/slideMaster1.xml': MASTER_XML,
            'ppt/slideMasters/_rels/slideMaster1.xml.rels': masterRelsXml(),
            'ppt/theme/theme1.xml': THEME_XML
        });
        const doc = await PptxXmlParser.parseZip(zip);
        expect(doc.slides[0].widthPx).toBe(1280);
        expect(doc.slides[0].heightPx).toBe(720);
    });

    it('detects a picture shape and resolves its zip target', async () => {
        const zip = buildBaseFixture(`
      <p:pic>
        <p:nvPicPr><p:cNvPr id="3" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rImg1"/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="100000" y="200000"/><a:ext cx="2000000" cy="1500000"/></a:xfrm></p:spPr>
      </p:pic>`,
            {
                'ppt/slides/_rels/slide1.xml.rels': slideRelsXml(true),
                'ppt/media/image1.png': { bytes: new Uint8Array([1, 2, 3]) }
            });
        const doc = await PptxXmlParser.parseZip(zip);
        const pictures = doc.slides[0].shapes.filter((s) => s.kind === 'picture');
        expect(pictures).toHaveLength(1);
        expect(pictures[0].pictureTarget).toBe('ppt/media/image1.png');
        expect(pictures[0].pictureMime).toBe('image/png');
        expect(pictures[0].width).toBeGreaterThan(0);
    });

    it('orders slides via presentation.xml sldIdLst, not zip enumeration order', async () => {
        const zip = makeFakeZip({
            'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS_ATTRS}>
                <p:sldIdLst>
                    <p:sldId id="256" r:id="rA"/>
                    <p:sldId id="257" r:id="rB"/>
                </p:sldIdLst>
                <p:sldSz cx="9144000" cy="6858000"/>
              </p:presentation>`,
            'ppt/_rels/presentation.xml.rels': `<?xml version="1.0"?>
              <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                <Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slideA.xml"/>
                <Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slideB.xml"/>
                <Relationship Id="rM" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
              </Relationships>`,
            'ppt/slides/slideA.xml': buildSlideXml(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100000" cy="100000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>FIRST</a:t></a:r></a:p></p:txBody></p:sp>`),
            'ppt/slides/slideB.xml': buildSlideXml(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100000" cy="100000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>SECOND</a:t></a:r></a:p></p:txBody></p:sp>`),
            'ppt/slides/_rels/slideA.xml.rels': slideRelsXml(),
            'ppt/slides/_rels/slideB.xml.rels': slideRelsXml(),
            'ppt/slideLayouts/slideLayout1.xml': LAYOUT_XML,
            'ppt/slideLayouts/_rels/slideLayout1.xml.rels': layoutRelsXml(),
            'ppt/slideMasters/slideMaster1.xml': MASTER_XML,
            'ppt/slideMasters/_rels/slideMaster1.xml.rels': masterRelsXml(),
            'ppt/theme/theme1.xml': THEME_XML
        });
        const doc = await PptxXmlParser.parseZip(zip);
        expect(doc.totalSlides).toBe(2);
        expect(doc.slides[0].shapes[0].paragraphs?.[0].text).toBe('FIRST');
        expect(doc.slides[1].shapes[0].paragraphs?.[0].text).toBe('SECOND');
    });

    it('hides English master prompt text when the slide does not override it', async () => {
        const layoutWithPrompt = `<?xml version="1.0"?><p:sldLayout ${NS_ATTRS} type="obj">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="4" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="500000" y="500000"/><a:ext cx="2000000" cy="800000"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/>
        <a:p><a:r><a:t>Click to edit Master text styles</a:t></a:r></a:p>
        <a:p><a:pPr lvl="1"/><a:r><a:t>Second level</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldLayout>`;
        const slideWithRealText = `<p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Real"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="500000"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Real body</a:t></a:r></a:p></p:txBody>
    </p:sp>`;
        const zip = buildBaseFixture(slideWithRealText, {
            'ppt/slideLayouts/slideLayout1.xml': layoutWithPrompt
        });
        const doc = await PptxXmlParser.parseZip(zip);
        const texts = doc.slides[0].shapes
            .filter((s) => s.kind === 'text')
            .flatMap((s) => s.paragraphs?.map((p) => p.text) || []);
        expect(texts).toContain('Real body');
        expect(texts).not.toContain('Click to edit Master text styles');
        expect(texts).not.toContain('Second level');
    });

    it('preserves grouped shape children with their absolute positions', async () => {
        const grouped = `<p:grpSp>
        <p:nvGrpSpPr><p:cNvPr id="3" name="Grouped"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm>
          <a:off x="0" y="6000000"/><a:ext cx="9144000" cy="400000"/>
          <a:chOff x="0" y="0"/><a:chExt cx="9144000" cy="400000"/>
        </a:xfrm></p:grpSpPr>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="4" name="Footer Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="400000"/></a:xfrm>
            <a:solidFill><a:srgbClr val="D9E2F3"/></a:solidFill>
          </p:spPr>
        </p:sp>
      </p:grpSp>`;
        const zip = buildBaseFixture(grouped);
        const doc = await PptxXmlParser.parseZip(zip);
        // Group child should appear shifted by the group offset (6000000 EMU
        // → 630px); fillColor should round-trip to lowercase hex.
        const filled = doc.slides[0].shapes.find((s) => s.fillColor === '#d9e2f3');
        expect(filled).toBeDefined();
        expect(filled?.y).toBeGreaterThan(600);
    });

    it('returns an empty document when the zip has no presentation', async () => {
        const zip = makeFakeZip({});
        const doc = await PptxXmlParser.parseZip(zip);
        expect(doc.totalSlides).toBe(0);
        expect(doc.slides).toEqual([]);
    });

    it('parses <a:srcRect> into percentage edges (1/1000pct → pct)', async () => {
        // l="25000" t="12500" r="0" b="0" → { l: 25, t: 12.5, r: 0, b: 0 }.
        const zip = buildBaseFixture(`
      <p:pic>
        <p:nvPicPr><p:cNvPr id="3" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="rImg1"/>
          <a:srcRect l="25000" t="12500" r="0" b="0"/>
        </p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1500000"/></a:xfrm></p:spPr>
      </p:pic>`,
            {
                'ppt/slides/_rels/slide1.xml.rels': slideRelsXml(true),
                'ppt/media/image1.png': { bytes: new Uint8Array([1, 2, 3]) }
            });
        const doc = await PptxXmlParser.parseZip(zip);
        const picture = doc.slides[0].shapes.find((s) => s.kind === 'picture');
        expect(picture?.srcRect).toEqual({ l: 25, t: 12.5, r: 0, b: 0 });
    });

    it('leaves srcRect undefined when the <a:srcRect> tag is absent', async () => {
        const zip = buildBaseFixture(`
      <p:pic>
        <p:nvPicPr><p:cNvPr id="3" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rImg1"/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1500000"/></a:xfrm></p:spPr>
      </p:pic>`,
            {
                'ppt/slides/_rels/slide1.xml.rels': slideRelsXml(true),
                'ppt/media/image1.png': { bytes: new Uint8Array([1, 2, 3]) }
            });
        const doc = await PptxXmlParser.parseZip(zip);
        const picture = doc.slides[0].shapes.find((s) => s.kind === 'picture');
        expect(picture?.srcRect).toBeUndefined();
    });

    it('treats an all-zero <a:srcRect> as undefined', async () => {
        const zip = buildBaseFixture(`
      <p:pic>
        <p:nvPicPr><p:cNvPr id="3" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="rImg1"/>
          <a:srcRect l="0" t="0" r="0" b="0"/>
        </p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1500000"/></a:xfrm></p:spPr>
      </p:pic>`,
            {
                'ppt/slides/_rels/slide1.xml.rels': slideRelsXml(true),
                'ppt/media/image1.png': { bytes: new Uint8Array([1, 2, 3]) }
            });
        const doc = await PptxXmlParser.parseZip(zip);
        const picture = doc.slides[0].shapes.find((s) => s.kind === 'picture');
        expect(picture?.srcRect).toBeUndefined();
    });

    it('substitutes a sibling raster fallback for an EMF picture target', async () => {
        const emfSlideRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.emf"/>
</Relationships>`;
        const zip = buildBaseFixture(`
      <p:pic>
        <p:nvPicPr><p:cNvPr id="3" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rImg1"/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1500000"/></a:xfrm></p:spPr>
      </p:pic>`,
            {
                'ppt/slides/_rels/slide1.xml.rels': emfSlideRels,
                'ppt/media/logo.emf': { bytes: new Uint8Array([0]) },
                'ppt/media/logo.png': { bytes: new Uint8Array([1, 2, 3]) }
            });
        const doc = await PptxXmlParser.parseZip(zip);
        const picture = doc.slides[0].shapes.find((s) => s.kind === 'picture');
        expect(picture?.pictureTarget).toBe('ppt/media/logo.png');
        expect(picture?.pictureMime).toBe('image/png');
        expect(picture?.vectorFallback).toBe(true);
    });

    it('keeps the original WMF target when no raster fallback exists', async () => {
        const wmfSlideRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/diagram.wmf"/>
</Relationships>`;
        const zip = buildBaseFixture(`
      <p:pic>
        <p:nvPicPr><p:cNvPr id="3" name="Diagram"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rImg1"/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1500000"/></a:xfrm></p:spPr>
      </p:pic>`,
            {
                'ppt/slides/_rels/slide1.xml.rels': wmfSlideRels,
                'ppt/media/diagram.wmf': { bytes: new Uint8Array([0]) }
            });
        const doc = await PptxXmlParser.parseZip(zip);
        const picture = doc.slides[0].shapes.find((s) => s.kind === 'picture');
        expect(picture?.pictureTarget).toBe('ppt/media/diagram.wmf');
        expect(picture?.vectorFallback).toBeFalsy();
    });

    it('extracts the slide background colour from layout/master fallbacks', async () => {
        const masterWithRedBg = `<?xml version="1.0"?><p:sldMaster ${NS_ATTRS}>
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
</p:sldMaster>`;
        const zip = buildBaseFixture('', {
            'ppt/slideMasters/slideMaster1.xml': masterWithRedBg
        });
        const doc = await PptxXmlParser.parseZip(zip);
        expect(doc.slides[0].backgroundColor).toBe('#ff0000');
    });
});

// ---------------------------------------------------------------------------
// graphicFrame: tables / charts / SmartArt (issue #74)
// ---------------------------------------------------------------------------

const URI_TABLE = 'http://schemas.openxmlformats.org/drawingml/2006/table';
const URI_CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const URI_DIAGRAM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';

function graphicFrameXml(uri: string, body: string, geom = '<a:xfrm><a:off x="100000" y="200000"/><a:ext cx="3000000" cy="2000000"/></a:xfrm>'): string {
    return `<p:graphicFrame>
      <p:nvGraphicFramePr><p:cNvPr id="9" name="GF"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
      <p:xfrm>${geom.replace(/<a:xfrm>|<\/a:xfrm>/g, '')}</p:xfrm>
      <a:graphicData uri="${uri}">${body}</a:graphicData>
    </p:graphicFrame>`;
}

function tableBody(): string {
    // 2 rows x 3 cols of plain text — exercise extractTableRows.
    return `<a:tbl>
      <a:tr>
        <a:tc><a:txBody><a:p><a:r><a:t>A1</a:t></a:r></a:p></a:txBody></a:tc>
        <a:tc><a:txBody><a:p><a:r><a:t>B1</a:t></a:r></a:p></a:txBody></a:tc>
        <a:tc><a:txBody><a:p><a:r><a:t>C1</a:t></a:r></a:p></a:txBody></a:tc>
      </a:tr>
      <a:tr>
        <a:tc><a:txBody><a:p><a:r><a:t>A2</a:t></a:r></a:p></a:txBody></a:tc>
        <a:tc><a:txBody><a:p><a:r><a:t>B2</a:t></a:r></a:p></a:txBody></a:tc>
        <a:tc><a:txBody><a:p><a:r><a:t>C2</a:t></a:r></a:p></a:txBody></a:tc>
      </a:tr>
    </a:tbl>`;
}

function chartRef(relId: string): string {
    return `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${relId}"/>`;
}

function slideRelsWithChartXml(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>`;
}

const STACKED_COLUMN_CHART_XML = `<?xml version="1.0" encoding="UTF-8"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title><c:tx><c:rich><a:p><a:r><a:t>Quarterly Sales</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="stacked"/>
        <c:ser>
          <c:idx val="0"/>
          <c:tx><c:strRef><c:f>x</c:f><c:strCache><c:pt idx="0"><c:v>North</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:strCache>
            <c:pt idx="0"><c:v>Q1</c:v></c:pt>
            <c:pt idx="1"><c:v>Q2</c:v></c:pt>
          </c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:numCache>
            <c:pt idx="0"><c:v>10</c:v></c:pt>
            <c:pt idx="1"><c:v>20</c:v></c:pt>
          </c:numCache></c:numRef></c:val>
        </c:ser>
        <c:ser>
          <c:idx val="1"/>
          <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>South</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:val><c:numRef><c:numCache>
            <c:pt idx="0"><c:v>5</c:v></c:pt>
            <c:pt idx="1"><c:v>15</c:v></c:pt>
          </c:numCache></c:numRef></c:val>
        </c:ser>
      </c:barChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`;

const LINE_CHART_XML = `<?xml version="1.0" encoding="UTF-8"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title><c:tx><c:rich><a:p><a:r><a:t>Trend</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea>
      <c:lineChart>
        <c:ser>
          <c:idx val="0"/>
          <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Visits</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:strCache>
            <c:pt idx="0"><c:v>Mon</c:v></c:pt>
            <c:pt idx="1"><c:v>Tue</c:v></c:pt>
            <c:pt idx="2"><c:v>Wed</c:v></c:pt>
          </c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:numCache>
            <c:pt idx="0"><c:v>100</c:v></c:pt>
            <c:pt idx="1"><c:v>150</c:v></c:pt>
            <c:pt idx="2"><c:v>120</c:v></c:pt>
          </c:numCache></c:numRef></c:val>
        </c:ser>
      </c:lineChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`;

const PIE_CHART_XML = `<?xml version="1.0" encoding="UTF-8"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title><c:tx><c:rich><a:p><a:r><a:t>Slice</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea><c:pie3DChart><c:ser/></c:pie3DChart></c:plotArea>
  </c:chart>
</c:chartSpace>`;

describe('PptxXmlParser extractTableRows', () => {
    it('flattens <a:tr>/<a:tc> into a 2x3 string matrix', () => {
        const rows = PptxXmlParser.extractTableRows(tableBody());
        expect(rows).toEqual([
            ['A1', 'B1', 'C1'],
            ['A2', 'B2', 'C2']
        ]);
    });

    it('joins multiple <a:t> runs inside one cell with spaces', () => {
        const xml = `<a:tbl><a:tr>
          <a:tc><a:txBody><a:p><a:r><a:t>Hello</a:t></a:r><a:r><a:t>World</a:t></a:r></a:p></a:txBody></a:tc>
        </a:tr></a:tbl>`;
        expect(PptxXmlParser.extractTableRows(xml)).toEqual([['Hello World']]);
    });

    it('surfaces merged-away cells as empty strings (hMerge / vMerge)', () => {
        const xml = `<a:tbl><a:tr>
          <a:tc><a:txBody><a:p><a:r><a:t>Anchor</a:t></a:r></a:p></a:txBody></a:tc>
          <a:tc hMerge="1"><a:txBody><a:p/></a:txBody></a:tc>
          <a:tc vMerge="1"><a:txBody><a:p/></a:txBody></a:tc>
        </a:tr></a:tbl>`;
        expect(PptxXmlParser.extractTableRows(xml)).toEqual([['Anchor', '', '']]);
    });
});

describe('PptxXmlParser parseChartData', () => {
    const ctx = PptxXmlParser.buildColorContext(
        PptxXmlParser.parseTheme(THEME_XML),
        MASTER_XML,
        '',
        ''
    );

    it('parses stacked column charts into categories + series', () => {
        const data = PptxXmlParser.parseChartData(STACKED_COLUMN_CHART_XML, ctx);
        expect(data).toBeDefined();
        expect(data?.kind).toBe('stackedColumn');
        expect(data?.categories).toEqual(['Q1', 'Q2']);
        expect(data?.series).toHaveLength(2);
        expect(data?.series[0]).toEqual({ name: 'North', values: [10, 20] });
        expect(data?.series[1]).toEqual({ name: 'South', values: [5, 15] });
    });

    it('parses line charts into categories + series', () => {
        const data = PptxXmlParser.parseChartData(LINE_CHART_XML, ctx);
        expect(data?.kind).toBe('line');
        expect(data?.categories).toEqual(['Mon', 'Tue', 'Wed']);
        expect(data?.series).toEqual([{ name: 'Visits', values: [100, 150, 120] }]);
    });

    it('returns undefined for unsupported chart kinds (e.g. pie)', () => {
        expect(PptxXmlParser.parseChartData(PIE_CHART_XML, ctx)).toBeUndefined();
    });

    it('returns undefined when the input chart XML is empty', () => {
        expect(PptxXmlParser.parseChartData('', ctx)).toBeUndefined();
    });
});

describe('PptxXmlParser graphicFrame dispatch (parseZip)', () => {
    it('produces a kind: table shape for table graphicData URIs', async () => {
        const zip = buildBaseFixture(graphicFrameXml(URI_TABLE, tableBody()));
        const doc = await PptxXmlParser.parseZip(zip);
        const tables = doc.slides[0].shapes.filter((s) => s.kind === 'table');
        expect(tables).toHaveLength(1);
        const t = tables[0];
        expect(t.tableRows).toEqual([
            ['A1', 'B1', 'C1'],
            ['A2', 'B2', 'C2']
        ]);
        // Geometry survives: 100000 EMU → 11px, 200000 EMU → 21px.
        expect(t.x).toBeGreaterThanOrEqual(10);
        expect(t.y).toBeGreaterThanOrEqual(20);
        expect(t.width).toBeGreaterThan(0);
        expect(t.height).toBeGreaterThan(0);
    });

    it('produces a kind: chart shape with stackedColumn chartData', async () => {
        const zip = buildBaseFixture(graphicFrameXml(URI_CHART, chartRef('rChart1')), {
            'ppt/slides/_rels/slide1.xml.rels': slideRelsWithChartXml(),
            'ppt/charts/chart1.xml': STACKED_COLUMN_CHART_XML
        });
        const doc = await PptxXmlParser.parseZip(zip);
        const charts = doc.slides[0].shapes.filter((s) => s.kind === 'chart');
        expect(charts).toHaveLength(1);
        const c = charts[0];
        expect(c.chartKind).toBe('stackedColumn');
        expect(c.chartTitle).toBe('Quarterly Sales');
        expect(c.chartData?.kind).toBe('stackedColumn');
        expect(c.chartData?.categories).toEqual(['Q1', 'Q2']);
        expect(c.chartData?.series).toHaveLength(2);
    });

    it('produces a kind: chart shape with line chartData', async () => {
        const zip = buildBaseFixture(graphicFrameXml(URI_CHART, chartRef('rChart1')), {
            'ppt/slides/_rels/slide1.xml.rels': slideRelsWithChartXml(),
            'ppt/charts/chart1.xml': LINE_CHART_XML
        });
        const doc = await PptxXmlParser.parseZip(zip);
        const c = doc.slides[0].shapes.find((s) => s.kind === 'chart');
        expect(c?.chartKind).toBe('line');
        expect(c?.chartData?.kind).toBe('line');
        expect(c?.chartData?.categories).toEqual(['Mon', 'Tue', 'Wed']);
    });

    it('resolves the chart relationship rId to the correct ppt/charts/chartN.xml part', async () => {
        // Use a non-default rel id + a chart at chart7.xml to prove the
        // parser actually walks the rels map rather than guessing.
        const customRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rChartZ" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart7.xml"/>
</Relationships>`;
        const zip = buildBaseFixture(graphicFrameXml(URI_CHART, chartRef('rChartZ')), {
            'ppt/slides/_rels/slide1.xml.rels': customRels,
            'ppt/charts/chart7.xml': LINE_CHART_XML
        });
        const doc = await PptxXmlParser.parseZip(zip);
        const c = doc.slides[0].shapes.find((s) => s.kind === 'chart');
        expect(c?.chartTitle).toBe('Trend');
        expect(c?.chartData?.kind).toBe('line');
    });

    it('falls back to kind: chart + chartTitle only when the chart kind is unsupported', async () => {
        const zip = buildBaseFixture(graphicFrameXml(URI_CHART, chartRef('rChart1')), {
            'ppt/slides/_rels/slide1.xml.rels': slideRelsWithChartXml(),
            'ppt/charts/chart1.xml': PIE_CHART_XML
        });
        const doc = await PptxXmlParser.parseZip(zip);
        const c = doc.slides[0].shapes.find((s) => s.kind === 'chart');
        expect(c).toBeDefined();
        expect(c?.chartTitle).toBe('Slice');
        expect(c?.chartKind).toBeUndefined();
        expect(c?.chartData).toBeUndefined();
    });

    it('produces a kind: diagram shape for SmartArt graphicData URIs', async () => {
        const zip = buildBaseFixture(graphicFrameXml(URI_DIAGRAM, '<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>'));
        const doc = await PptxXmlParser.parseZip(zip);
        const diagrams = doc.slides[0].shapes.filter((s) => s.kind === 'diagram');
        expect(diagrams).toHaveLength(1);
        const d = diagrams[0];
        expect(d.tableRows).toBeUndefined();
        expect(d.chartData).toBeUndefined();
        // Geometry survives.
        expect(d.width).toBeGreaterThan(0);
        expect(d.height).toBeGreaterThan(0);
        // Title falls back to "SmartArt" in the absence of layout metadata.
        expect(d.chartTitle).toBe('SmartArt');
    });
});

// ---------------------------------------------------------------------------
// Shape geometry (preset / custom / connectors) — issue #75
// ---------------------------------------------------------------------------

function shapeXmlForPreset(prst: string, opts: {
    fill?: string;
    border?: string;
    extraSpPr?: string;
    extraShape?: string;
    flipH?: boolean;
    flipV?: boolean;
    rot?: number;
} = {}): string {
    const fill = opts.fill ? `<a:solidFill><a:srgbClr val="${opts.fill}"/></a:solidFill>` : '';
    const lnFill = opts.border ? `<a:solidFill><a:srgbClr val="${opts.border}"/></a:solidFill>` : '';
    const xfrmAttrs = [
        opts.rot ? `rot="${opts.rot}"` : '',
        opts.flipH ? 'flipH="1"' : '',
        opts.flipV ? 'flipV="1"' : ''
    ].filter(Boolean).join(' ');
    return `<p:sp>
        <p:nvSpPr><p:cNvPr id="9" name="Shape ${prst}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm ${xfrmAttrs}><a:off x="100000" y="200000"/><a:ext cx="2000000" cy="1000000"/></a:xfrm>
          <a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>
          ${fill}
          ${opts.border !== undefined ? `<a:ln>${lnFill}</a:ln>` : ''}
          ${opts.extraSpPr || ''}
        </p:spPr>
        ${opts.extraShape || ''}
      </p:sp>`;
}

describe('PptxXmlParser shape geometry (issue #75)', () => {
    it('parses <a:prstGeom prst="rect"> into a kind: shape with presetGeom: "rect"', async () => {
        const zip = buildBaseFixture(shapeXmlForPreset('rect', { fill: '4472C4' }));
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape).toBeDefined();
        expect(shape?.presetGeom).toBe('rect');
        expect(shape?.fillColor).toBe('#4472c4');
    });

    it('parses <a:prstGeom prst="ellipse"> as presetGeom', async () => {
        const zip = buildBaseFixture(shapeXmlForPreset('ellipse', { fill: 'FF0000' }));
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape?.presetGeom).toBe('ellipse');
    });

    it('parses <a:prstGeom prst="roundRect"> as presetGeom', async () => {
        const zip = buildBaseFixture(shapeXmlForPreset('roundRect', { fill: '70AD47' }));
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape?.presetGeom).toBe('roundRect');
        expect(shape?.fillColor).toBe('#70ad47');
    });

    it('emits customSvgPath from <a:custGeom> with moveTo / lnTo / close commands', async () => {
        const custShape = `<p:sp>
          <p:nvSpPr><p:cNvPr id="11" name="Custom"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm>
            <a:custGeom>
              <a:avLst/>
              <a:pathLst>
                <a:path w="100" h="100">
                  <a:moveTo><a:pt x="0" y="0"/></a:moveTo>
                  <a:lnTo><a:pt x="100" y="0"/></a:lnTo>
                  <a:lnTo><a:pt x="100" y="100"/></a:lnTo>
                  <a:close/>
                </a:path>
              </a:pathLst>
            </a:custGeom>
            <a:solidFill><a:srgbClr val="123456"/></a:solidFill>
          </p:spPr>
        </p:sp>`;
        const zip = buildBaseFixture(custShape);
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape).toBeDefined();
        const path = shape?.customSvgPath || '';
        // Path width is 1000000 EMU = ~105px; the custGeom local coords go
        // 0..100, so each unit ≈ 1.05px and the scaled path should contain
        // the moveto, two linetos, and a close command in order.
        expect(path).toMatch(/^M\s+0\s+0\b/);
        expect(path).toContain('L ');
        expect(path.endsWith(' Z')).toBe(true);
    });

    it('parses <a:cubicBezTo> into a C path command', () => {
        const xml = `<a:custGeom>
          <a:pathLst>
            <a:path w="100" h="100">
              <a:moveTo><a:pt x="0" y="0"/></a:moveTo>
              <a:cubicBezTo>
                <a:pt x="10" y="10"/>
                <a:pt x="20" y="20"/>
                <a:pt x="30" y="30"/>
              </a:cubicBezTo>
            </a:path>
          </a:pathLst>
        </a:custGeom>`;
        const path = PptxXmlParser.parseCustomGeometryPath(xml, 100, 100);
        expect(path).toBeDefined();
        expect(path).toMatch(/C\s+10\s+10\s+20\s+20\s+30\s+30/);
    });

    it('returns undefined custSvgPath when width or height is zero', () => {
        const xml = `<a:custGeom><a:pathLst><a:path w="10" h="10"><a:moveTo><a:pt x="0" y="0"/></a:moveTo></a:path></a:pathLst></a:custGeom>`;
        expect(PptxXmlParser.parseCustomGeometryPath(xml, 0, 100)).toBeUndefined();
        expect(PptxXmlParser.parseCustomGeometryPath(xml, 100, 0)).toBeUndefined();
    });

    it('parses <a:headEnd type="triangle"/> into headEnd', async () => {
        const lineShape = shapeXmlForPreset('straightConnector1', {
            border: '000000',
            extraSpPr: '<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:headEnd type="triangle"/><a:tailEnd type="none"/></a:ln>'
        }).replace('<a:ln><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>', '');
        const zip = buildBaseFixture(lineShape);
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape?.headEnd).toBe('triangle');
        expect(shape?.tailEnd).toBe('none');
    });

    it('parses <a:ln w="38100"/> into borderWidthPx === 3', () => {
        const xml = '<p:spPr><a:ln w="38100"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr>';
        expect(PptxXmlParser.extractLineWidthPx(xml)).toBe(3);
    });

    it('returns undefined borderWidthPx when <a:ln> is absent', () => {
        const xml = '<p:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>';
        expect(PptxXmlParser.extractLineWidthPx(xml)).toBeUndefined();
    });

    it('returns undefined borderWidthPx when <a:ln> has no w attribute', () => {
        const xml = '<p:spPr><a:ln><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr>';
        expect(PptxXmlParser.extractLineWidthPx(xml)).toBeUndefined();
    });

    it('clamps a negative <a:ln w> to zero', () => {
        const xml = '<p:spPr><a:ln w="-100"/></p:spPr>';
        expect(PptxXmlParser.extractLineWidthPx(xml)).toBe(0);
    });

    it('preserves fillColor on a shape produced from <p:sp> with <a:prstGeom prst="rect">', async () => {
        const zip = buildBaseFixture(shapeXmlForPreset('rect', { fill: 'ABCDEF' }));
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape).toBeDefined();
        expect(shape?.kind).toBe('shape');
        expect(shape?.presetGeom).toBe('rect');
        expect(shape?.fillColor).toBe('#abcdef');
    });

    it('drops fillColor when <a:noFill> is set', async () => {
        const noFillShape = `<p:sp>
          <p:nvSpPr><p:cNvPr id="13" name="NoFill"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
            <a:ln><a:solidFill><a:srgbClr val="111111"/></a:solidFill></a:ln>
          </p:spPr>
        </p:sp>`;
        const zip = buildBaseFixture(noFillShape);
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape).toBeDefined();
        expect(shape?.fillColor).toBeUndefined();
        expect(shape?.borderColor).toBe('#111111');
    });

    it('drops borderColor when only the line color is unset (noLine has no a:solidFill)', async () => {
        // The parser's `extractLineColor` resolves the color from the <a:ln>
        // child; when <a:ln> contains no fill the color is undefined.
        const shapeXml = `<p:sp>
          <p:nvSpPr><p:cNvPr id="14" name="NoLine"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>
            <a:ln w="0"><a:noFill/></a:ln>
          </p:spPr>
        </p:sp>`;
        const zip = buildBaseFixture(shapeXml);
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape?.fillColor).toBe('#00ff00');
        expect(shape?.borderColor).toBeUndefined();
        // borderWidthPx still surfaces — width=0 EMU = 0px (parser clamps).
        expect(shape?.borderWidthPx).toBe(0);
    });

    it('plumbs flipH / flipV from <a:xfrm> onto the shape', async () => {
        const zip = buildBaseFixture(
            shapeXmlForPreset('rightArrow', { fill: 'AA0000', flipH: true, flipV: true, rot: 2700000 })
        );
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape).toBeDefined();
        expect(shape?.flipH).toBe(true);
        expect(shape?.flipV).toBe(true);
        // rotateDeg from rot="2700000" → 45 deg (rot / 60000).
        expect(shape?.rotateDeg).toBe(45);
    });

    it('extracts <p:cxnSp> connector blocks the same way as <p:sp>', async () => {
        const cxn = `<p:cxnSp>
          <p:nvCxnSpPr><p:cNvPr id="22" name="Conn"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="0"/></a:xfrm>
            <a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>
            <a:ln w="12700"><a:solidFill><a:srgbClr val="222222"/></a:solidFill><a:tailEnd type="triangle"/></a:ln>
          </p:spPr>
        </p:cxnSp>`;
        const zip = buildBaseFixture(cxn);
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape).toBeDefined();
        expect(shape?.presetGeom).toBe('straightConnector1');
        expect(shape?.tailEnd).toBe('triangle');
        expect(shape?.borderColor).toBe('#222222');
        expect(shape?.borderWidthPx).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Theme colour transforms / gradient / dash / anchor — issue #77
// ---------------------------------------------------------------------------

describe('PptxXmlParser colour transforms (issue #77)', () => {
    it('converts a hex string to RGB and back', () => {
        expect(PptxXmlParser.hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
        expect(PptxXmlParser.hexToRgb('#000')).toEqual({ r: 0, g: 0, b: 0 });
        expect(PptxXmlParser.hexToRgb('#abc')).toEqual({ r: 170, g: 187, b: 204 });
        expect(PptxXmlParser.hexToRgb('not-hex')).toBeNull();
        expect(PptxXmlParser.rgbToHex(255, 0, 0)).toBe('#ff0000');
        expect(PptxXmlParser.rgbToHex(170, 187, 204)).toBe('#aabbcc');
    });

    it('returns the input hex when no colour-transform children are present', () => {
        expect(PptxXmlParser.applyColorTransforms('#123456', '<a:schemeClr val="accent1"/>'))
            .toBe('#123456');
    });

    it('applies <a:lumMod>/<a:lumOff> to lighten a colour', () => {
        // Black + lumMod=60% + lumOff=40% → 0 * 0.6 + 255 * 0.4 = 102 → #666666.
        const xml = '<a:schemeClr val="dk1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>';
        expect(PptxXmlParser.applyColorTransforms('#000000', xml)).toBe('#666666');
    });

    it('applies <a:tint> to lighten an srgb colour towards white', () => {
        // Black + tint=50% → 0 + (255-0)*0.5 = 127.5 → rounds to 128 → #808080.
        const xml = '<a:srgbClr val="000000"><a:tint val="50000"/></a:srgbClr>';
        expect(PptxXmlParser.applyColorTransforms('#000000', xml)).toBe('#808080');
    });

    it('applies <a:shade> to darken an srgb colour towards black', () => {
        // White + shade=50% → 255*0.5 = 127.5 → 128 → #808080.
        const xml = '<a:srgbClr val="FFFFFF"><a:shade val="50000"/></a:srgbClr>';
        expect(PptxXmlParser.applyColorTransforms('#ffffff', xml)).toBe('#808080');
    });

    it('extractColorFromXml honours <a:schemeClr> with lumMod/lumOff', () => {
        const theme = PptxXmlParser.parseTheme(THEME_XML);
        const ctx = PptxXmlParser.buildColorContext(theme, MASTER_XML, '', '');
        // tx1 → dk1 → #000000; with lumMod=60% lumOff=40% → #666666.
        const xml = '<a:solidFill><a:schemeClr val="tx1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr></a:solidFill>';
        expect(PptxXmlParser.extractColorFromXml(xml, ctx)).toBe('#666666');
    });

    it('extractColorFromXml honours <a:srgbClr> with tint', () => {
        const theme = PptxXmlParser.parseTheme(THEME_XML);
        const ctx = PptxXmlParser.buildColorContext(theme, MASTER_XML, '', '');
        const xml = '<a:srgbClr val="000000"><a:tint val="50000"/></a:srgbClr>';
        expect(PptxXmlParser.extractColorFromXml(xml, ctx)).toBe('#808080');
    });

    it('extractColorFromXml honours <a:prstClr> (preset names)', () => {
        const theme = PptxXmlParser.parseTheme(THEME_XML);
        const ctx = PptxXmlParser.buildColorContext(theme, MASTER_XML, '', '');
        expect(PptxXmlParser.extractColorFromXml('<a:prstClr val="red"/>', ctx)).toBe('#ff0000');
        expect(PptxXmlParser.extractColorFromXml('<a:prstClr val="black"/>', ctx)).toBe('#000000');
        expect(PptxXmlParser.extractColorFromXml('<a:prstClr val="white"><a:shade val="50000"/></a:prstClr>', ctx)).toBe('#808080');
    });

    it('extractGradientFill returns sorted stops and angle from <a:lin ang=...>', () => {
        const theme = PptxXmlParser.parseTheme(THEME_XML);
        const ctx = PptxXmlParser.buildColorContext(theme, MASTER_XML, '', '');
        const xml = `<p:spPr>
          <a:gradFill>
            <a:gsLst>
              <a:gs pos="100000"><a:srgbClr val="FF0000"/></a:gs>
              <a:gs pos="0"><a:srgbClr val="0000FF"/></a:gs>
            </a:gsLst>
            <a:lin ang="0" scaled="1"/>
          </a:gradFill>
        </p:spPr>`;
        const grad = PptxXmlParser.extractGradientFill(xml, ctx);
        expect(grad).toBeDefined();
        expect(grad?.stops).toHaveLength(2);
        expect(grad?.stops[0]).toEqual({ offset: 0, color: '#0000ff' });
        expect(grad?.stops[1]).toEqual({ offset: 100, color: '#ff0000' });
        // ang="0" in OOXML = 0° clockwise from east = "to right". The
        // helper adds +90 so CSS sees it as 90° ("to right").
        expect(grad?.angleDeg).toBe(90);
    });

    it('extractGradientFill returns undefined when <a:gradFill> is absent', () => {
        const theme = PptxXmlParser.parseTheme(THEME_XML);
        const ctx = PptxXmlParser.buildColorContext(theme, MASTER_XML, '', '');
        expect(PptxXmlParser.extractGradientFill('<p:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>', ctx)).toBeUndefined();
    });

    it('extractGradientFill duplicates a single-stop gradient to a valid pair', () => {
        const theme = PptxXmlParser.parseTheme(THEME_XML);
        const ctx = PptxXmlParser.buildColorContext(theme, MASTER_XML, '', '');
        const xml = `<p:spPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="123456"/></a:gs></a:gsLst></a:gradFill></p:spPr>`;
        const grad = PptxXmlParser.extractGradientFill(xml, ctx);
        expect(grad?.stops).toHaveLength(2);
        expect(grad?.stops[0].color).toBe('#123456');
        expect(grad?.stops[1].color).toBe('#123456');
    });

    it('extractGradientFill returns undefined when noFill is set even with a stray gradFill block', () => {
        const theme = PptxXmlParser.parseTheme(THEME_XML);
        const ctx = PptxXmlParser.buildColorContext(theme, MASTER_XML, '', '');
        const xml = '<p:spPr><a:noFill/><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="123456"/></a:gs></a:gsLst></a:gradFill></p:spPr>';
        expect(PptxXmlParser.extractGradientFill(xml, ctx)).toBeUndefined();
    });

    it('extractLineDash returns the preset string from <a:prstDash val=...>', () => {
        const xml = '<p:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="dash"/></a:ln></p:spPr>';
        expect(PptxXmlParser.extractLineDash(xml)).toBe('dash');
    });

    it('extractLineDash returns undefined when <a:prstDash> is absent', () => {
        expect(PptxXmlParser.extractLineDash('<p:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="000"/></a:solidFill></a:ln></p:spPr>')).toBeUndefined();
        // Also undefined when there's no <a:ln> at all.
        expect(PptxXmlParser.extractLineDash('<p:spPr><a:solidFill><a:srgbClr val="000"/></a:solidFill></p:spPr>')).toBeUndefined();
    });

    it('extractBodyAnchor reads anchor="ctr|t|b" from <a:bodyPr>', () => {
        expect(PptxXmlParser.extractBodyAnchor('<p:sp><p:txBody><a:bodyPr anchor="ctr"/></p:txBody></p:sp>')).toBe('ctr');
        expect(PptxXmlParser.extractBodyAnchor('<p:sp><p:txBody><a:bodyPr anchor="t"/></p:txBody></p:sp>')).toBe('t');
        expect(PptxXmlParser.extractBodyAnchor('<p:sp><p:txBody><a:bodyPr anchor="b" wrap="square"/></p:txBody></p:sp>')).toBe('b');
        expect(PptxXmlParser.extractBodyAnchor('<p:sp><p:txBody><a:bodyPr wrap="square"/></p:txBody></p:sp>')).toBeUndefined();
    });

    it('extracts borderDash + anchor onto a parsed shape (end-to-end)', async () => {
        const shapeXml = `<p:sp>
          <p:nvSpPr><p:cNvPr id="55" name="Dashed"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="500000"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
            <a:ln w="19050"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="dashDot"/></a:ln>
          </p:spPr>
          <p:txBody>
            <a:bodyPr anchor="ctr"/>
            <a:lstStyle/>
            <a:p><a:r><a:rPr lang="en-US" sz="1800"/><a:t>Hello</a:t></a:r></a:p>
          </p:txBody>
        </p:sp>`;
        const zip = buildBaseFixture(shapeXml);
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'text');
        expect(shape).toBeDefined();
        expect(shape?.borderDash).toBe('dashDot');
        expect(shape?.anchor).toBe('ctr');
        expect(shape?.borderWidthPx).toBeCloseTo(1.5, 1);
    });

    it('surfaces gradientFill onto a parsed shape (end-to-end)', async () => {
        const shapeXml = `<p:sp>
          <p:nvSpPr><p:cNvPr id="60" name="Grad"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="500000"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:gradFill>
              <a:gsLst>
                <a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>
                <a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs>
              </a:gsLst>
              <a:lin ang="5400000" scaled="1"/>
            </a:gradFill>
          </p:spPr>
        </p:sp>`;
        const zip = buildBaseFixture(shapeXml);
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape?.gradientFill).toBeDefined();
        expect(shape?.gradientFill?.stops).toEqual([
            { offset: 0, color: '#ff0000' },
            { offset: 100, color: '#0000ff' }
        ]);
        // ang="5400000" / 60000 = 90° OOXML (south) → +90 = 180° CSS (to bottom).
        expect(shape?.gradientFill?.angleDeg).toBe(180);
    });

    it('preserves explicit fillColor distinct from noFill (invariant)', async () => {
        const explicitFill = `<p:sp>
          <p:nvSpPr><p:cNvPr id="71" name="Filled"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill>
          </p:spPr>
        </p:sp>`;
        const zip = buildBaseFixture(explicitFill);
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape?.fillColor).toBe('#abcdef');
        expect(shape?.gradientFill).toBeUndefined();
    });

    it('respects <a:noFill/> inside <a:ln> as noLine (borderColor undefined)', async () => {
        const xml = `<p:sp>
          <p:nvSpPr><p:cNvPr id="72" name="NoLine"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>
            <a:ln w="12700"><a:noFill/></a:ln>
          </p:spPr>
        </p:sp>`;
        const zip = buildBaseFixture(xml);
        const doc = await PptxXmlParser.parseZip(zip);
        const shape = doc.slides[0].shapes.find((s) => s.kind === 'shape');
        expect(shape?.borderColor).toBeUndefined();
        // borderWidthPx still surfaces (1px = 12700 EMU).
        expect(shape?.borderWidthPx).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Issue #79: no-renderable-shapes fallback dispatch + raw-text extractor.
// ---------------------------------------------------------------------------

describe('countPptxRenderableShapes (issue #79)', () => {
    it('counts text shapes with at least one non-empty paragraph', async () => {
        const slideBody = `<p:sp>
          <p:nvSpPr><p:cNvPr id="10" name="t1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="200000"/></a:xfrm></p:spPr>
          <p:txBody><a:bodyPr/><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:txBody>
        </p:sp>`;
        const zip = buildBaseFixture(slideBody);
        const doc = await PptxXmlParser.parseZip(zip);
        expect(countPptxRenderableShapes(doc)).toBeGreaterThan(0);
    });

    it('returns 0 when every slide has zero renderable shapes', async () => {
        // Empty <p:spTree> — no <p:sp>, no <p:pic>, no graphic frame.
        const zip = buildBaseFixture('');
        const doc = await PptxXmlParser.parseZip(zip);
        expect(countPptxRenderableShapes(doc)).toBe(0);
    });

    it('excludes bare placeholder shapes (no text content)', () => {
        // Synthetic doc — bypass the parser to assert the renderable
        // gate's classifier directly. We only need the discriminator on
        // each shape, so the fields can be minimal.
        const fakeDoc = {
            slides: [{
                slideNumber: 1,
                widthPx: 960,
                heightPx: 720,
                backgroundColor: '#ffffff',
                shapes: [{
                    kind: 'placeholder',
                    x: 0, y: 0, width: 100, height: 100,
                    zIndex: 0, sourcePriority: 3
                } as PptxShape]
            }],
            totalSlides: 1,
            zip: makeFakeZip({})
        };
        expect(countPptxRenderableShapes(fakeDoc)).toBe(0);
    });

    it('counts table / chart / diagram / shape kinds as renderable', () => {
        const kinds = ['table', 'chart', 'diagram', 'shape'] as const;
        const fakeDoc = {
            slides: [{
                slideNumber: 1,
                widthPx: 960,
                heightPx: 720,
                backgroundColor: '#ffffff',
                shapes: kinds.map((k, i) => ({
                    kind: k,
                    x: 0, y: 0, width: 100, height: 100,
                    zIndex: i, sourcePriority: 3
                } as PptxShape))
            }],
            totalSlides: 1,
            zip: makeFakeZip({})
        };
        expect(countPptxRenderableShapes(fakeDoc)).toBe(kinds.length);
    });
});

describe('extractPptxFallbackText (issue #79)', () => {
    function slideXmlWithRawText(text: string): string {
        return `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS_ATTRS}>
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
    }

    it('returns per-slide raw text in presentation order', async () => {
        const zip = makeFakeZip({
            'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS_ATTRS}>
                <p:sldIdLst>
                  <p:sldId id="256" r:id="rA"/>
                  <p:sldId id="257" r:id="rB"/>
                </p:sldIdLst>
                <p:sldSz cx="9144000" cy="6858000"/>
              </p:presentation>`,
            'ppt/_rels/presentation.xml.rels': `<?xml version="1.0"?>
                <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                  <Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
                  <Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
                </Relationships>`,
            'ppt/slides/slide1.xml': slideXmlWithRawText('first slide'),
            'ppt/slides/slide2.xml': slideXmlWithRawText('second slide')
        });
        const out = await extractPptxFallbackText(zip);
        expect(out).toHaveLength(2);
        expect(out[0]).toContain('first slide');
        expect(out[1]).toContain('second slide');
    });

    it('returns empty strings for slides that contain no <a:t> tags', async () => {
        const zip = makeFakeZip({
            'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS_ATTRS}>
                <p:sldIdLst><p:sldId id="256" r:id="rA"/></p:sldIdLst>
                <p:sldSz cx="9144000" cy="6858000"/>
              </p:presentation>`,
            'ppt/_rels/presentation.xml.rels': `<?xml version="1.0"?>
                <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                  <Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
                </Relationships>`,
            'ppt/slides/slide1.xml': `<?xml version="1.0"?><p:sld ${NS_ATTRS}><p:cSld><p:spTree/></p:cSld></p:sld>`
        });
        const out = await extractPptxFallbackText(zip);
        expect(out).toEqual(['']);
    });

    it('decodes XML entities inside <a:t> payloads', async () => {
        const zip = makeFakeZip({
            'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS_ATTRS}>
                <p:sldIdLst><p:sldId id="256" r:id="rA"/></p:sldIdLst>
                <p:sldSz cx="9144000" cy="6858000"/>
              </p:presentation>`,
            'ppt/_rels/presentation.xml.rels': `<?xml version="1.0"?>
                <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                  <Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
                </Relationships>`,
            'ppt/slides/slide1.xml': slideXmlWithRawText('a &amp; b &lt;c&gt;')
        });
        const out = await extractPptxFallbackText(zip);
        expect(out[0]).toContain('a & b <c>');
    });

    it('falls back to slide-glob ordering when presentation.xml is missing', async () => {
        // No `ppt/presentation.xml` — the helper should still surface
        // text from any `ppt/slides/slideN.xml` it finds.
        const zip = makeFakeZip({
            'ppt/slides/slide1.xml': slideXmlWithRawText('orphan one'),
            'ppt/slides/slide2.xml': slideXmlWithRawText('orphan two')
        });
        const out = await extractPptxFallbackText(zip);
        expect(out).toHaveLength(2);
        expect(out[0]).toContain('orphan one');
        expect(out[1]).toContain('orphan two');
    });

    it('returns [] when the zip has no slide entries at all', async () => {
        const zip = makeFakeZip({});
        const out = await extractPptxFallbackText(zip);
        expect(out).toEqual([]);
    });

    it('treats an undefined zip defensively (no throw)', async () => {
        // Cast-through-unknown is the lint-clean way to feed a malformed
        // value into the helper for a defensiveness check.
        const out = await extractPptxFallbackText(undefined as unknown as PptxZip);
        expect(out).toEqual([]);
    });
});

describe('PPTX fallback dispatch: end-to-end gate', () => {
    it('primary path is used when the deck has renderable shapes', async () => {
        const slideBody = `<p:sp>
          <p:nvSpPr><p:cNvPr id="10" name="t1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="200000"/></a:xfrm></p:spPr>
          <p:txBody><a:bodyPr/><a:p><a:r><a:t>real text</a:t></a:r></a:p></p:txBody>
        </p:sp>`;
        const zip = buildBaseFixture(slideBody);
        const doc = await PptxXmlParser.parseZip(zip);
        expect(countPptxRenderableShapes(doc)).toBeGreaterThan(0);
        // Fallback would have been skipped — verify by calling it and
        // making sure the primary parse already saw the same text.
        const fallback = await extractPptxFallbackText(zip);
        expect(fallback[0]).toContain('real text');
    });
});

