// HWP / HWPX layout types. Issue #54.
//
// Pragmatic subset of `vscode-omni-viewer/src/utils/hwpDocumentTypes.ts`.
// The full VSCode type set models pages, footnotes, columns, anchored
// shapes, etc. — none of which the Chrome viewer renders yet. We keep
// only the shapes the HWPX renderer actually consumes:
//
//   - paragraph runs (text + bold / italic / size / color)
//   - paragraphs (alignment, line height, runs)
//   - tables (rows × cells of paragraphs)
//   - a top-level document (format + pages of paragraph blocks)
//
// The field names match the VSCode reference so a future port that
// fills in the deferred features (images, shapes, layout) can drop into
// the same surface.

export type HwpSourceFormat = 'hwp' | 'hwpx';

export interface HwpLayoutRun {
    text: string;
    fontSizePt?: number;
    fontWeight?: string;
    fontStyle?: string;
    textDecoration?: string;
    verticalAlign?: 'super' | 'sub';
    color?: string;
    backgroundColor?: string;
}

export type HwpParagraphAlign = 'left' | 'center' | 'right' | 'justify';

export interface HwpLayoutParagraph {
    id: string;
    kind: 'paragraph';
    align: HwpParagraphAlign;
    lineHeight: number;
    fontSizePt?: number;
    runs: HwpLayoutRun[];
}

export interface HwpLayoutTableCell {
    id: string;
    paragraphs: HwpLayoutParagraph[];
    colSpan: number;
    rowSpan: number;
    backgroundColor?: string;
    borderColor?: string;
    textAlign?: HwpParagraphAlign;
}

export interface HwpLayoutTableRow {
    cells: HwpLayoutTableCell[];
}

export interface HwpLayoutTableBlock {
    id: string;
    kind: 'table';
    rows: HwpLayoutTableRow[];
}

export type HwpLayoutBlock = HwpLayoutParagraph | HwpLayoutTableBlock;

export interface HwpLayoutPage {
    id: string;
    sectionIndex?: number;
    blocks: HwpLayoutBlock[];
}

export interface HwpLayoutDocument {
    format: HwpSourceFormat;
    fileName: string;
    fileSize?: string;
    pages: HwpLayoutPage[];
    warnings: string[];
}
