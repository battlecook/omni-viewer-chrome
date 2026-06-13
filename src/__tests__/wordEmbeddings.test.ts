// Unit tests for the Word embeddings scanner (issue #45).
//
// Coverage:
//   - `scanEmbeddings` plucks `word/embeddings/*.xlsx` and
//     `word/charts/chart*.xml` from a JSZip-shaped object, ignores
//     unrelated paths, and returns a deterministic ordering.
//   - `extractWorkbookPreview` clips to 10 × 10, reports the
//     pre-truncation totals + truncated flag, and stringifies cell
//     contents.
//   - `extractChartXml` is a thin pass-through to the entry's
//     `async('string')` reader.
//
// We mock JSZip with plain in-memory entries; tests never touch the
// real vendor bundle.

import {
    extractChartXml,
    extractWorkbookPreview,
    scanEmbeddings,
    WORD_EMBED_PREVIEW_MAX_COLS,
    WORD_EMBED_PREVIEW_MAX_ROWS,
    ZipEntry,
    ZipLike
} from '../templates/word/js/wordEmbeddings';

function makeEntry(
    name: string,
    payload: { uint8?: Uint8Array; text?: string }
): ZipEntry {
    return {
        name,
        async: (type: string) => {
            if (type === 'uint8array') {
                return Promise.resolve(payload.uint8 ?? new Uint8Array());
            }
            if (type === 'string') {
                return Promise.resolve(payload.text ?? '');
            }
            return Promise.reject(new Error(`unsupported type ${type}`));
        }
    } as ZipEntry;
}

function makeZip(entries: Record<string, ZipEntry>): ZipLike {
    return {
        files: entries,
        file(path: string): ZipEntry | null {
            return entries[path] ?? null;
        }
    };
}

describe('scanEmbeddings', () => {
    it('finds workbook embeddings under word/embeddings/', () => {
        const zip = makeZip({
            'word/document.xml': makeEntry('word/document.xml', { text: '' }),
            'word/embeddings/oleObject1.xlsx': makeEntry(
                'word/embeddings/oleObject1.xlsx',
                {}
            ),
            'word/embeddings/Microsoft_Excel_Worksheet.xlsx': makeEntry(
                'word/embeddings/Microsoft_Excel_Worksheet.xlsx',
                {}
            ),
            'word/charts/chart1.xml': makeEntry('word/charts/chart1.xml', {
                text: '<c:chart/>'
            })
        });

        const manifest = scanEmbeddings(zip);

        expect(manifest.workbooks).toHaveLength(2);
        expect(
            manifest.workbooks.map((w) => w.path)
        ).toEqual([
            'word/embeddings/Microsoft_Excel_Worksheet.xlsx',
            'word/embeddings/oleObject1.xlsx'
        ]);
        expect(manifest.workbooks[0].extension).toBe('xlsx');
        expect(manifest.workbooks[0].fileName).toBe(
            'Microsoft_Excel_Worksheet.xlsx'
        );
    });

    it('finds chart XML files under word/charts/', () => {
        const zip = makeZip({
            'word/charts/chart1.xml': makeEntry('word/charts/chart1.xml', {
                text: ''
            }),
            'word/charts/chart10.xml': makeEntry('word/charts/chart10.xml', {
                text: ''
            }),
            'word/charts/_rels/chart1.xml.rels': makeEntry(
                'word/charts/_rels/chart1.xml.rels',
                { text: '' }
            ),
            'word/charts/colors1.xml': makeEntry('word/charts/colors1.xml', {
                text: ''
            }),
            'word/charts/style1.xml': makeEntry('word/charts/style1.xml', {
                text: ''
            })
        });

        const manifest = scanEmbeddings(zip);

        expect(manifest.charts.map((c) => c.fileName)).toEqual([
            'chart1.xml',
            'chart10.xml'
        ]);
    });

    it('ignores unrelated files', () => {
        const zip = makeZip({
            'word/document.xml': makeEntry('word/document.xml', {}),
            '[Content_Types].xml': makeEntry('[Content_Types].xml', {}),
            'word/media/image1.png': makeEntry('word/media/image1.png', {}),
            'word/footer1.xml': makeEntry('word/footer1.xml', {}),
            // Directory placeholder entries should be skipped.
            'word/embeddings/': makeEntry('word/embeddings/', {})
        });

        const manifest = scanEmbeddings(zip);
        expect(manifest.workbooks).toHaveLength(0);
        expect(manifest.charts).toHaveLength(0);
    });

    it('skips embedded files with unsupported extensions', () => {
        const zip = makeZip({
            'word/embeddings/oleObject1.bin': makeEntry(
                'word/embeddings/oleObject1.bin',
                {}
            ),
            'word/embeddings/note.docx': makeEntry(
                'word/embeddings/note.docx',
                {}
            )
        });
        const manifest = scanEmbeddings(zip);
        expect(manifest.workbooks).toHaveLength(0);
    });

    it('keeps legacy xls/xlsb embeddings (so the panel can list them)', () => {
        const zip = makeZip({
            'word/embeddings/legacy1.xls': makeEntry(
                'word/embeddings/legacy1.xls',
                {}
            ),
            'word/embeddings/binary1.xlsb': makeEntry(
                'word/embeddings/binary1.xlsb',
                {}
            )
        });
        const manifest = scanEmbeddings(zip);
        expect(manifest.workbooks.map((w) => w.extension).sort()).toEqual([
            'xls',
            'xlsb'
        ]);
    });

    it('returns an empty manifest for a docx without embeddings', () => {
        const zip = makeZip({
            'word/document.xml': makeEntry('word/document.xml', {})
        });
        const manifest = scanEmbeddings(zip);
        expect(manifest.workbooks).toEqual([]);
        expect(manifest.charts).toEqual([]);
    });
});

describe('extractWorkbookPreview', () => {
    /**
     * Build a SheetJS-shaped stub. Just enough of `read` and
     * `utils.sheet_to_json` to round-trip a 2D array of cells through
     * the helper.
     */
    function makeXlsxStub(matrix: unknown[][]): {
        read: jest.Mock;
        utils: { sheet_to_json: jest.Mock };
    } {
        return {
            read: jest.fn(() => ({
                SheetNames: ['Sheet1'],
                Sheets: { Sheet1: { __aoa: matrix } }
            })),
            utils: {
                sheet_to_json: jest.fn(
                    (sheet: { __aoa: unknown[][] }) => sheet.__aoa
                )
            }
        };
    }

    it('returns the first sheet name and rows clipped to 10 × 10', async () => {
        const big: unknown[][] = [];
        for (let r = 0; r < 25; r++) {
            const row: unknown[] = [];
            for (let c = 0; c < 25; c++) row.push(`r${r}c${c}`);
            big.push(row);
        }
        const xlsx = makeXlsxStub(big);
        const entry = makeEntry('word/embeddings/wb.xlsx', {
            uint8: new Uint8Array([0x50, 0x4b])
        });

        const preview = await extractWorkbookPreview(entry, xlsx);

        expect(preview.sheetName).toBe('Sheet1');
        expect(preview.rows).toHaveLength(WORD_EMBED_PREVIEW_MAX_ROWS);
        for (const row of preview.rows) {
            expect(row).toHaveLength(WORD_EMBED_PREVIEW_MAX_COLS);
        }
        expect(preview.rows[0][0]).toBe('r0c0');
        expect(preview.totalRows).toBe(25);
        expect(preview.totalColumns).toBe(25);
        expect(preview.truncated).toBe(true);
        expect(xlsx.read).toHaveBeenCalledTimes(1);
        expect(xlsx.read.mock.calls[0][1]).toEqual({ type: 'array' });
    });

    it('preserves small sheets without trimming', async () => {
        const small: unknown[][] = [
            ['name', 'qty', 'price'],
            ['apple', 3, 1.5],
            ['pear', null, 2.25]
        ];
        const xlsx = makeXlsxStub(small);
        const entry = makeEntry('word/embeddings/wb.xlsx', {});

        const preview = await extractWorkbookPreview(entry, xlsx);

        expect(preview.totalRows).toBe(3);
        expect(preview.totalColumns).toBe(3);
        expect(preview.truncated).toBe(false);
        expect(preview.rows[1]).toEqual(['apple', '3', '1.5']);
        expect(preview.rows[2][1]).toBe('');
    });

    it('throws when the workbook has no sheets', async () => {
        const xlsx = {
            read: jest.fn(() => ({ SheetNames: [], Sheets: {} })),
            utils: { sheet_to_json: jest.fn() }
        };
        const entry = makeEntry('word/embeddings/wb.xlsx', {});

        await expect(extractWorkbookPreview(entry, xlsx)).rejects.toThrow(
            /no sheets/i
        );
    });

    it('throws when xlsxLib is missing', async () => {
        const entry = makeEntry('word/embeddings/wb.xlsx', {});
        await expect(
            extractWorkbookPreview(entry, undefined as unknown as never)
        ).rejects.toThrow(/xlsx library/i);
    });
});

describe('extractChartXml', () => {
    it('reads the chart entry as a UTF-8 string', async () => {
        const xml = '<?xml version="1.0"?><c:chartSpace/>';
        const entry = makeEntry('word/charts/chart1.xml', { text: xml });
        const out = await extractChartXml(entry);
        expect(out).toBe(xml);
    });
});
