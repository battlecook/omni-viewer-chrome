// Browser-only HWPX parser. Issue #54.
//
// This is a deliberate minimum-subset port of
// `vscode-omni-viewer/src/utils/hwpDocumentParser.ts` (~133 KB). The
// VSCode parser handles HWPX + binary HWP, headers / footers, columns,
// images, shapes, footnotes, etc. We port only what the Chrome viewer
// renders today:
//
//   1. Open HWPX (zip) via JSZip — caller passes in the JSZip namespace
//      because vendor loading is centralized in the viewer module.
//   2. Read every `Contents/section*.xml` and parse `<hp:p>` paragraphs
//      with text runs `<hp:run>` (bold / italic / size / color).
//   3. Parse `<hp:tbl>` tables with rows / cells of paragraphs.
//
// Out of scope (deferred to follow-up issues):
//   - binary `.hwp` files (those go through the rhwp WASM path, #53)
//   - images, shapes, lines, text boxes
//   - headers / footers, footnotes / endnotes
//   - columns, page padding, advanced layout
//   - style references (`pIDRef` / `charPrIDRef` resolution against
//     `header.xml`)
//
// The regex-driven approach mirrors the VSCode source — XML namespace
// prefixes vary across HWPX writers, so we use namespace-loose patterns
// like `<[^>]*?:p\b ... </[^>]*?:p>` rather than DOMParser. This also
// keeps the module pure (no DOM dependency) so it can be unit-tested in
// jsdom or node without spinning up an HTML environment.
//
// All exported functions are pure with no top-level side effects.

import {
    HwpLayoutBlock,
    HwpLayoutDocument,
    HwpLayoutPage,
    HwpLayoutParagraph,
    HwpLayoutRun,
    HwpLayoutTableBlock,
    HwpLayoutTableCell,
    HwpLayoutTableRow,
    HwpParagraphAlign,
} from './hwpDocumentTypes';

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- Public types -------------------------------------------------------

/**
 * Subset of the JSZip surface we use. Caller hands us a constructor
 * (`window.JSZip`) so vendor loading lives in the template module —
 * this parser stays pure.
 */
export interface JsZipLike {
    loadAsync(data: ArrayBuffer | Uint8Array): Promise<JsZipArchive>;
}

export interface JsZipArchive {
    files: Record<string, JsZipFile>;
}

export interface JsZipFile {
    name: string;
    dir?: boolean;
    async(type: 'text'): Promise<string>;
}

export interface JsZipConstructor {
    new (): JsZipLike;
    loadAsync(data: ArrayBuffer | Uint8Array): Promise<JsZipArchive>;
}

// --- Top-level entry ----------------------------------------------------

/**
 * Parse an `.hwpx` byte buffer into a `HwpLayoutDocument`. Each
 * `Contents/section*.xml` becomes one page in the output.
 *
 * `JSZip` is injected so the template module owns vendor loading.
 * Errors propagate to the caller (e.g. malformed zip) — the viewer
 * surfaces them in the inline error panel.
 */
export async function parseHwpxBuffer(
    bytes: Uint8Array | ArrayBuffer,
    JSZip: JsZipConstructor,
    fileName = 'document.hwpx',
    fileSize?: string
): Promise<HwpLayoutDocument> {
    const zip = await JSZip.loadAsync(bytes);
    const sectionNames = Object.keys(zip.files)
        .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
        .sort((left, right) =>
            left.localeCompare(right, undefined, { numeric: true })
        );

    const warnings: string[] = [];
    const pages: HwpLayoutPage[] = [];

    for (const [index, sectionName] of sectionNames.entries()) {
        const xml = await zip.files[sectionName].async('text');
        pages.push(parseHwpxSectionXml(xml, index));
    }

    if (pages.length === 0) {
        warnings.push('HWPX section XML not found; rendering empty document.');
        pages.push(createEmptyPage(0));
    }

    return {
        format: 'hwpx',
        fileName,
        fileSize,
        pages,
        warnings,
    };
}

/**
 * Parse one `<hs:sec>` / section XML string into a single
 * `HwpLayoutPage`. Exported so unit tests can exercise the parser
 * without going through JSZip.
 *
 * Structure: paragraphs and tables can interleave in the section. We
 * walk both pattern matches and order them by source index so the
 * output preserves the source order.
 */
export function parseHwpxSectionXml(xml: string, index: number): HwpLayoutPage {
    const blocks = extractHwpxBlocks(xml, index);
    return {
        id: `hwpx-page-${index + 1}`,
        sectionIndex: index + 1,
        blocks: blocks.length > 0 ? blocks : [createEmptyParagraph(index)],
    };
}

// --- Block extraction ---------------------------------------------------

/**
 * Walk paragraphs and tables in source order. The HWPX schema nests
 * tables inside paragraphs (`<hp:p><hp:run><hp:tbl>...`) — we extract
 * tables separately and skip the cell content from the paragraph runs
 * by stripping `<hp:tbl>` blocks before run extraction.
 */
function extractHwpxBlocks(xml: string, pageIndex: number): HwpLayoutBlock[] {
    const tables = extractHwpxTables(xml, pageIndex);
    const tableRanges = tables.map((t) => ({
        start: t.sourceIndex,
        end: t.sourceIndex + t.length,
    }));

    // Strip table XML inline so the paragraph extractor does not see
    // their `<hp:p>` cell contents twice.
    const xmlWithoutTables = stripTableBlocks(xml);
    const paragraphs = extractHwpxParagraphs(xmlWithoutTables, pageIndex);

    const ordered: Array<{ pos: number; block: HwpLayoutBlock }> = [];
    paragraphs.forEach((paragraph, idx) =>
        ordered.push({ pos: paragraph.sourceIndex, block: toParagraphBlock(paragraph, pageIndex, idx) })
    );
    tables.forEach((table, idx) =>
        ordered.push({
            pos: tableRanges[idx].start,
            block: { id: `hwpx-table-${pageIndex + 1}-${idx + 1}`, kind: 'table', rows: table.rows },
        })
    );
    ordered.sort((a, b) => a.pos - b.pos);
    return ordered.map((entry) => entry.block);
}

interface ParsedParagraph {
    sourceIndex: number;
    align: HwpParagraphAlign;
    lineHeight: number;
    fontSizePt?: number;
    runs: HwpLayoutRun[];
}

interface ParsedTable {
    sourceIndex: number;
    length: number;
    rows: HwpLayoutTableRow[];
}

function toParagraphBlock(
    parsed: ParsedParagraph,
    pageIndex: number,
    paragraphIndex: number
): HwpLayoutParagraph {
    return {
        id: `hwpx-p-${pageIndex + 1}-${paragraphIndex + 1}`,
        kind: 'paragraph',
        align: parsed.align,
        lineHeight: parsed.lineHeight,
        fontSizePt: parsed.fontSizePt,
        runs: parsed.runs,
    };
}

// --- Paragraphs ---------------------------------------------------------

/**
 * Replace each `<hp:tbl>...</hp:tbl>` (or namespace-equivalent) with a
 * blank string of the same length so source-index offsets are preserved
 * for ordering. We don't want to renumber paragraph positions.
 */
function stripTableBlocks(xml: string): string {
    return xml.replace(/<[^>]*?:tbl\b[\s\S]*?<\/[^>]*?:tbl>/gi, (match) =>
        ' '.repeat(match.length)
    );
}

function extractHwpxParagraphs(xml: string, _pageIndex: number): ParsedParagraph[] {
    const normalized = xml
        .replace(/<w:br\s*\/>/gi, '\n')
        .replace(/<hp:lineBreak\s*\/>/gi, '\n');
    const paragraphMatches = [...normalized.matchAll(/<[^>]*?:p\b[\s\S]*?<\/[^>]*?:p>/gi)];
    const paragraphs: ParsedParagraph[] = [];

    for (const paragraphMatch of paragraphMatches) {
        const paragraphXml = paragraphMatch[0];
        const runs = extractHwpxRuns(paragraphXml);
        const hasText = runs.some((run) => (run.text || '').trim().length > 0);
        if (!hasText) {
            continue;
        }

        paragraphs.push({
            sourceIndex: paragraphMatch.index ?? 0,
            align: extractParagraphAlign(paragraphXml),
            lineHeight: 1.65,
            fontSizePt: runs[0]?.fontSizePt,
            runs,
        });
    }

    return paragraphs;
}

function extractParagraphAlign(paragraphXml: string): HwpParagraphAlign {
    const direct = readXmlAttribute(
        paragraphXml,
        /(?:align|horzAlign|paraAlign)="([^"]+)"/i
    );
    return mapHwpxAlign(direct);
}

/**
 * Pull text runs from a paragraph. HWPX wraps each text fragment in
 * `<hp:t>...</hp:t>` inside a `<hp:run>...</hp:run>`. Run-level
 * attributes (bold / italic / size / color) live on neighbouring
 * `<hp:charPr>` blocks in the schema, but writers commonly inline them
 * onto the run element — we accept both shapes.
 *
 * Falls back to "strip all tags" for paragraphs without explicit runs
 * so HWPX writers that emit raw text in `<hp:p>` still produce
 * something visible.
 */
function extractHwpxRuns(paragraphXml: string): HwpLayoutRun[] {
    const runMatches = [...paragraphXml.matchAll(/<[^>]*?:run\b[\s\S]*?<\/[^>]*?:run>/gi)];

    if (runMatches.length === 0) {
        const text = decodeXmlText(paragraphXml.replace(/<[^>]+>/g, '')).trim();
        return text ? [{ text, fontSizePt: 11 }] : [];
    }

    const runs: HwpLayoutRun[] = [];
    for (const runMatch of runMatches) {
        const runXml = runMatch[0];
        const textMatches = runXml.match(/<[^>]*?:t\b[^>]*>([\s\S]*?)<\/[^>]*?:t>/gi) ?? [];
        const rawText = textMatches
            .map((segment) => segment.replace(/<[^>]+>/g, ''))
            .join('');
        const text = decodeXmlText(rawText);
        if (!text) {
            continue;
        }

        runs.push({
            text,
            fontSizePt: hwpxUnitToPt(readXmlNumber(runXml, /(?:fontSize|sz)="(\d+)"/i), 11),
            fontWeight: /(?:bold|fontWt)="(?:1|true|bold|700)"/i.test(runXml) ? '700' : undefined,
            fontStyle: /(?:italic|fontStyle)="(?:1|true|italic)"/i.test(runXml) ? 'italic' : undefined,
            textDecoration: resolveHwpxTextDecoration(runXml),
            verticalAlign: resolveHwpxVerticalAlign(runXml),
            color: normalizeHwpxColor(readXmlAttribute(runXml, /(?:textColor|color)="([^"]+)"/i)),
            backgroundColor: normalizeHwpxColor(
                readXmlAttribute(runXml, /(?:shadeColor|fillColor|backColor)="([^"]+)"/i)
            ),
        });
    }
    return runs;
}

// --- Tables -------------------------------------------------------------

function extractHwpxTables(xml: string, pageIndex: number): ParsedTable[] {
    const tableMatches = [...xml.matchAll(/<[^>]*?:tbl\b[\s\S]*?<\/[^>]*?:tbl>/gi)];

    return tableMatches.map((tableMatch, tableIndex): ParsedTable => {
        const tableXml = tableMatch[0];
        const tableStart = tableMatch.index ?? 0;
        const rowMatches = [...tableXml.matchAll(/<[^>]*?:tr\b[\s\S]*?<\/[^>]*?:tr>/gi)];
        const rows: HwpLayoutTableRow[] = rowMatches.map((rowMatch, rowIndex) => {
            const rowXml = rowMatch[0];
            const cellMatches = [...rowXml.matchAll(/<[^>]*?:tc\b[\s\S]*?<\/[^>]*?:tc>/gi)];
            const cells: HwpLayoutTableCell[] = cellMatches.map((cellMatch, cellIndex) => {
                const cellXml = cellMatch[0];
                const cellId = `hwpx-cell-${pageIndex + 1}-${tableIndex + 1}-${rowIndex + 1}-${cellIndex + 1}`;
                const cellParagraphs = extractHwpxParagraphs(cellXml, pageIndex).map(
                    (paragraph, idx): HwpLayoutParagraph => ({
                        id: `${cellId}-p-${idx + 1}`,
                        kind: 'paragraph',
                        align: paragraph.align,
                        lineHeight: paragraph.lineHeight,
                        fontSizePt: paragraph.fontSizePt,
                        runs: paragraph.runs,
                    })
                );

                // Ensure every cell has at least an empty paragraph so the
                // renderer always emits a `<td>` (cell borders need to
                // show even for empty cells).
                if (cellParagraphs.length === 0) {
                    const fallbackText = decodeXmlText(
                        cellXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
                    ).trim();
                    cellParagraphs.push({
                        id: `${cellId}-p-1`,
                        kind: 'paragraph',
                        align: 'left',
                        lineHeight: 1.65,
                        fontSizePt: 11,
                        runs: fallbackText ? [{ text: fallbackText, fontSizePt: 11 }] : [],
                    });
                }

                const colSpan = readXmlNumber(cellXml, /(?:colSpan|gridSpan)="(\d+)"/i) ?? 1;
                const rowSpan = readXmlNumber(cellXml, /(?:rowSpan|rowMerge)="(\d+)"/i) ?? 1;
                return {
                    id: cellId,
                    paragraphs: cellParagraphs,
                    colSpan,
                    rowSpan,
                    backgroundColor: normalizeHwpxColor(
                        readXmlAttribute(cellXml, /(?:fillColor|backColor|bgColor)="([^"]+)"/i)
                    ),
                    borderColor: normalizeHwpxColor(
                        readXmlAttribute(cellXml, /(?:borderColor|lineColor)="([^"]+)"/i)
                    ),
                    textAlign: mapHwpxAlign(
                        readXmlAttribute(cellXml, /(?:align|horzAlign)="([^"]+)"/i)
                    ),
                };
            });
            return { cells };
        }).filter((row) => row.cells.length > 0);

        return {
            sourceIndex: tableStart,
            length: tableXml.length,
            rows,
        };
    }).filter((table) => table.rows.length > 0);
}

// --- Helpers ------------------------------------------------------------

function createEmptyPage(index: number): HwpLayoutPage {
    return {
        id: `hwpx-page-${index + 1}`,
        sectionIndex: index + 1,
        blocks: [createEmptyParagraph(index)],
    };
}

function createEmptyParagraph(pageIndex: number): HwpLayoutParagraph {
    return {
        id: `hwpx-empty-paragraph-${pageIndex + 1}`,
        kind: 'paragraph',
        align: 'left',
        lineHeight: 1.65,
        fontSizePt: 11,
        runs: [],
    };
}

function mapHwpxAlign(value: string | undefined): HwpParagraphAlign {
    switch ((value || '').toLowerCase()) {
        case 'center':
        case 'middle':
            return 'center';
        case 'right':
            return 'right';
        case 'justify':
        case 'distribute':
            return 'justify';
        default:
            return 'left';
    }
}

function readXmlAttribute(xml: string, pattern: RegExp): string | undefined {
    return xml.match(pattern)?.[1];
}

function readXmlNumber(xml: string, pattern: RegExp): number | undefined {
    const rawValue = readXmlAttribute(xml, pattern);
    if (rawValue === undefined) {
        return undefined;
    }
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : undefined;
}

/**
 * HWPX dimensions are stored in HWPUNIT (= 1/7200 inch). We convert to
 * CSS points (1 pt = 1/72 inch). Mirrors the VSCode reference.
 */
function hwpxUnitToPt(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }
    return Number((((value as number) / 7200) * 72).toFixed(2));
}

function normalizeHwpxColor(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const normalized = value.replace(/^#/, '').trim();
    if (/^[0-9a-f]{6}$/i.test(normalized)) {
        return `#${normalized}`;
    }
    return undefined;
}

function resolveHwpxTextDecoration(runXml: string): string | undefined {
    const decorations: string[] = [];
    if (/(?:underline|underLine|textDecoration)="(?:1|true|single|underline)"/i.test(runXml)) {
        decorations.push('underline');
    }
    if (/(?:strike|strikeout|lineThrough|textLineThrough)="(?:1|true|single|line-through|strike)"/i.test(runXml)) {
        decorations.push('line-through');
    }
    return decorations.length > 0 ? decorations.join(' ') : undefined;
}

function resolveHwpxVerticalAlign(runXml: string): 'super' | 'sub' | undefined {
    const verticalAlign =
        readXmlAttribute(runXml, /(?:vertAlign|baselineShift|script)="([^"]+)"/i) || '';
    if (/(super|superscript)/i.test(verticalAlign)) {
        return 'super';
    }
    if (/(sub|subscript)/i.test(verticalAlign)) {
        return 'sub';
    }
    return undefined;
}

function decodeXmlText(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}
