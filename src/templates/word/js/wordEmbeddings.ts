// Embedded-object scanner for the Chrome Word viewer (issue #45).
//
// .docx is a ZIP — Office stores embedded Excel workbooks as
// `word/embeddings/*.xlsx` (and `.xlsb`, `.xls` legacy variants) and
// charts as `word/charts/chart*.xml`. This module discovers those
// entries, hands the workbook bytes off to SheetJS for a small preview,
// and returns chart-XML payloads as plain strings for `wordChartSvg.ts`
// to convert.
//
// The module is intentionally library-agnostic: callers pass in a
// JSZip-shaped object (or a structurally compatible test stub) so the
// scanner is unit-testable without spinning up the real vendor bundle.
//
// Scope cuts (per issue #45 pragmatic plan):
//   - Workbook preview is limited to the FIRST sheet, FIRST 10 rows × 10
//     columns.
//   - Embedded `.xlsb` / legacy `.xls` files are listed but not
//     decoded — the preview surface shows their filename only.
//   - Charts are exposed as raw XML; semantic parsing lives in
//     `wordChartSvg.ts`.

/* eslint-disable @typescript-eslint/no-explicit-any */

export const WORD_EMBED_PREVIEW_MAX_ROWS = 10;
export const WORD_EMBED_PREVIEW_MAX_COLS = 10;

/**
 * Minimal shape we rely on from JSZip. The real lib exposes a much
 * larger surface; this is just enough for the embeddings scanner so
 * tests can pass a plain in-memory map.
 */
export interface ZipEntry {
    name: string;
    async(type: 'uint8array'): Promise<Uint8Array>;
    async(type: 'string'): Promise<string>;
    async(type: string): Promise<unknown>;
}

export interface ZipLike {
    /** All entries keyed by full path, mirroring JSZip's internal layout. */
    files: Record<string, ZipEntry>;
    /** Lookup by exact path. JSZip returns null for misses. */
    file(path: string): ZipEntry | null;
}

export interface WorkbookEmbedding {
    /** Full ZIP path, e.g. `word/embeddings/oleObject1.xlsx`. */
    path: string;
    /** Bare filename (no directory). */
    fileName: string;
    /** Lowercase file extension without the dot, e.g. `xlsx`. */
    extension: string;
}

export interface ChartEmbedding {
    /** Full ZIP path, e.g. `word/charts/chart1.xml`. */
    path: string;
    /** Bare filename. */
    fileName: string;
}

export interface EmbeddingsManifest {
    workbooks: WorkbookEmbedding[];
    charts: ChartEmbedding[];
}

const EMBEDDINGS_PREFIX = 'word/embeddings/';
const CHARTS_PREFIX = 'word/charts/';
const CHART_FILE_RE = /^chart\d+\.xml$/i;
const SUPPORTED_WORKBOOK_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xlsb', 'xls']);

function basename(path: string): string {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
}

function extname(name: string): string {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * Walk the docx zip and pluck out:
 *   - workbook embeddings under `word/embeddings/`
 *   - chart XML files under `word/charts/` matching `chart\d+\.xml`
 *
 * Returns a manifest with stable sort: workbooks/charts ordered by
 * lexicographic path so the rendered panel ordering is deterministic.
 */
export function scanEmbeddings(zip: ZipLike): EmbeddingsManifest {
    const workbooks: WorkbookEmbedding[] = [];
    const charts: ChartEmbedding[] = [];

    const files = zip.files || {};
    for (const path of Object.keys(files)) {
        if (!path) continue;
        // Skip directory placeholder entries (`word/embeddings/`).
        if (path.endsWith('/')) continue;

        if (path.toLowerCase().startsWith(EMBEDDINGS_PREFIX)) {
            const fileName = basename(path);
            const ext = extname(fileName);
            if (!SUPPORTED_WORKBOOK_EXTENSIONS.has(ext)) continue;
            workbooks.push({ path, fileName, extension: ext });
            continue;
        }

        if (path.toLowerCase().startsWith(CHARTS_PREFIX)) {
            const fileName = basename(path);
            if (!CHART_FILE_RE.test(fileName)) continue;
            charts.push({ path, fileName });
        }
    }

    workbooks.sort((a, b) => a.path.localeCompare(b.path));
    charts.sort((a, b) => a.path.localeCompare(b.path));

    return { workbooks, charts };
}

/** Result of decoding the first sheet of a workbook embedding. */
export interface WorkbookPreview {
    /** First sheet name from `Workbook.SheetNames[0]`. */
    sheetName: string;
    /**
     * 2D rows × cols matrix (already truncated to
     * `WORD_EMBED_PREVIEW_MAX_ROWS` × `WORD_EMBED_PREVIEW_MAX_COLS`).
     * Empty cells are stringified to `''`.
     */
    rows: string[][];
    /** Reported total rows of the underlying sheet (pre-truncation). */
    totalRows: number;
    /** Reported total columns (pre-truncation). */
    totalColumns: number;
    /** True when the matrix was clipped on either axis. */
    truncated: boolean;
}

/**
 * Decode the first sheet of a workbook embedding into a small preview
 * matrix. The caller passes the SheetJS namespace (`window.XLSX` after
 * `loadXlsx()`); we never `import 'xlsx'` directly so this remains
 * dep-free in tests.
 *
 * Throws when the entry can't be read or has no sheets — callers
 * surface the error inline in the embedded panel.
 */
export async function extractWorkbookPreview(
    entry: ZipEntry,
    xlsxLib: any
): Promise<WorkbookPreview> {
    if (!entry) throw new Error('word embeddings: workbook entry is missing');
    if (!xlsxLib || typeof xlsxLib.read !== 'function') {
        throw new Error('word embeddings: xlsx library is not loaded');
    }
    const bytes = (await entry.async('uint8array')) as Uint8Array;
    const wb = xlsxLib.read(bytes, { type: 'array' });
    const names: string[] = wb?.SheetNames || [];
    if (names.length === 0) {
        throw new Error('word embeddings: workbook has no sheets');
    }
    const sheetName = names[0];
    const sheet = wb.Sheets?.[sheetName];
    if (!sheet) {
        throw new Error(`word embeddings: sheet "${sheetName}" is missing`);
    }
    const aoa = (xlsxLib.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: ''
    }) || []) as unknown[][];
    const totalRows = aoa.length;
    const totalColumns = aoa.reduce(
        (max, row) => Math.max(max, Array.isArray(row) ? row.length : 0),
        0
    );

    const clippedRows = aoa.slice(0, WORD_EMBED_PREVIEW_MAX_ROWS);
    const rows: string[][] = clippedRows.map((row) => {
        const arr = Array.isArray(row) ? row : [];
        const clipped = arr.slice(0, WORD_EMBED_PREVIEW_MAX_COLS);
        return clipped.map((cell) =>
            cell === null || cell === undefined ? '' : String(cell)
        );
    });

    const truncated =
        totalRows > WORD_EMBED_PREVIEW_MAX_ROWS ||
        totalColumns > WORD_EMBED_PREVIEW_MAX_COLS;

    return { sheetName, rows, totalRows, totalColumns, truncated };
}

/**
 * Read a chart XML zip entry to a string. Thin wrapper kept here so the
 * embeddings module owns all docx-zip I/O for tests / mocks.
 */
export async function extractChartXml(entry: ZipEntry): Promise<string> {
    if (!entry) throw new Error('word embeddings: chart entry is missing');
    const text = (await entry.async('string')) as string;
    return text;
}
