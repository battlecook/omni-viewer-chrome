// Unit tests for the Excel viewer's "Toggle View" feature (issue #38).
//
// Coverage targets:
//   - `toggleViewMode` — the toggle state machine. Two states today
//     (table <-> raw); the helper exists so the contract is pinned.
//   - `serializeSheetForRaw` / `renderSheetAsRawJson` — the raw payload
//     shape (sheet -> JSON shape) the <pre> renders. Covers the metadata
//     fields (`name`, `headers`, `totalRows`, `totalColumns`, `rows`),
//     null-safety, and that the output round-trips through JSON.
//   - `mountExcelViewer` integration (jsdom) — DoD checks:
//       * Toggle View button flips visibility of table <-> raw <pre>
//       * Search input is disabled in raw mode and re-enabled in table mode
//       * Scroll-top is preserved when toggling between views
//
// The integration test mocks the SheetJS UMD bundle by stubbing
// `window.XLSX` directly so `parseWorkbookFromFile` doesn't try to fetch
// the real vendor script (which we don't ship in the test harness).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { ParsedSheet } from '../templates/excel/js/excelLoader';
import {
    ExcelViewMode,
    renderSheetAsRawJson,
    serializeSheetForRaw,
    toggleViewMode
} from '../templates/excel/js/excelRawToggle';

// --- pure state machine ---------------------------------------------------

describe('toggleViewMode', () => {
    it('flips table -> raw', () => {
        expect(toggleViewMode('table')).toBe<ExcelViewMode>('raw');
    });
    it('flips raw -> table', () => {
        expect(toggleViewMode('raw')).toBe<ExcelViewMode>('table');
    });
    it('is its own inverse (T -> R -> T)', () => {
        expect(toggleViewMode(toggleViewMode('table'))).toBe('table');
        expect(toggleViewMode(toggleViewMode('raw'))).toBe('raw');
    });
});

// --- raw payload serializer ----------------------------------------------

describe('serializeSheetForRaw', () => {
    const sheet: ParsedSheet = {
        name: 'Sheet1',
        headers: ['name', 'age'],
        rows: [
            ['Alice', 30],
            ['Bob', 25]
        ],
        totalRows: 2,
        totalColumns: 2
    };

    it('returns the full metadata + rows shape', () => {
        expect(serializeSheetForRaw(sheet)).toEqual({
            name: 'Sheet1',
            headers: ['name', 'age'],
            rows: [
                ['Alice', 30],
                ['Bob', 25]
            ],
            totalRows: 2,
            totalColumns: 2
        });
    });

    it('returns a deep-ish copy so callers cannot mutate the source sheet', () => {
        const out = serializeSheetForRaw(sheet);
        out.headers.push('zzz');
        out.rows[0].push('extra');
        expect(sheet.headers).toEqual(['name', 'age']);
        expect(sheet.rows[0]).toEqual(['Alice', 30]);
    });

    it('returns an empty payload for null/undefined input', () => {
        const empty = { name: '', headers: [], rows: [], totalRows: 0, totalColumns: 0 };
        expect(serializeSheetForRaw(null)).toEqual(empty);
        expect(serializeSheetForRaw(undefined)).toEqual(empty);
    });

    it('handles missing rows / headers arrays defensively', () => {
        const ragged = {
            name: 'X',
            headers: undefined as unknown as string[],
            rows: undefined as unknown as ParsedSheet['rows'],
            totalRows: 0,
            totalColumns: 0
        } as ParsedSheet;
        expect(serializeSheetForRaw(ragged)).toEqual({
            name: 'X',
            headers: [],
            rows: [],
            totalRows: 0,
            totalColumns: 0
        });
    });

    it('preserves primitive cell types (number / boolean / null)', () => {
        const s: ParsedSheet = {
            name: 'mix',
            headers: ['a', 'b', 'c'],
            rows: [[42, true, null]],
            totalRows: 1,
            totalColumns: 3
        };
        const out = serializeSheetForRaw(s);
        expect(out.rows[0][0]).toBe(42);
        expect(out.rows[0][1]).toBe(true);
        expect(out.rows[0][2]).toBe(null);
    });
});

describe('renderSheetAsRawJson', () => {
    const sheet: ParsedSheet = {
        name: 'Sheet1',
        headers: ['n'],
        rows: [[1], [2]],
        totalRows: 2,
        totalColumns: 1
    };

    it('matches `JSON.stringify(serializeSheetForRaw(sheet), null, 2)`', () => {
        expect(renderSheetAsRawJson(sheet)).toBe(
            JSON.stringify(serializeSheetForRaw(sheet), null, 2)
        );
    });

    it('produces output that round-trips through JSON.parse', () => {
        const parsed = JSON.parse(renderSheetAsRawJson(sheet));
        expect(parsed).toEqual(serializeSheetForRaw(sheet));
    });

    it('uses 2-space indentation (DoD wording)', () => {
        const text = renderSheetAsRawJson(sheet);
        // The first nested key should be indented with two spaces.
        expect(text.split('\n')[1]).toMatch(/^ {2}"/);
    });

    it('handles null input without throwing', () => {
        expect(() => renderSheetAsRawJson(null)).not.toThrow();
        expect(JSON.parse(renderSheetAsRawJson(null))).toEqual({
            name: '',
            headers: [],
            rows: [],
            totalRows: 0,
            totalColumns: 0
        });
    });
});

// --- jsdom integration (Toggle button + scroll preserve + search disable) -

describe('mountExcelViewer — Toggle View integration (#38)', () => {
    type FakeWb = {
        SheetNames: string[];
        Sheets: Record<string, unknown>;
    };

    interface XlsxMock {
        read: (data: unknown, opts: unknown) => FakeWb;
        utils: { sheet_to_json: (sheet: unknown, opts: unknown) => unknown[][] };
    }

    function installXlsxMock(rows: unknown[][]): void {
        const xlsx: XlsxMock = {
            read: () => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } }),
            utils: {
                sheet_to_json: () => rows
            }
        };
        (window as any).XLSX = xlsx;
    }

    function fakeFile(name = 'demo.xlsx'): File {
        // jsdom's File doesn't ship an `arrayBuffer()` method (it's part of
        // the Blob spec but jsdom's Blob shim is partial). The orchestrator
        // calls `file.arrayBuffer()` to feed bytes into SheetJS — since our
        // mocked XLSX.read ignores its first argument anyway, we just need
        // the call to resolve to something. Polyfill it on the instance.
        const file = new File(
            [new Uint8Array([0])],
            name,
            { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
        );
        if (typeof (file as unknown as { arrayBuffer?: unknown }).arrayBuffer !== 'function') {
            (file as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = () =>
                Promise.resolve(new ArrayBuffer(0));
        }
        return file;
    }

    async function flushAsync(): Promise<void> {
        // The viewer runs an async IIFE inside `mountExcelViewer` that
        // chains several awaits: `loadXlsx()` -> `file.arrayBuffer()` ->
        // `parseWorkbookFromFile` parsing -> back in the caller, `refresh()`.
        // A handful of macrotask + microtask flushes covers them all without
        // the test racing the orchestrator.
        for (let i = 0; i < 5; i++) {
            await new Promise<void>((r) => setTimeout(r, 0));
            await Promise.resolve();
        }
    }

    afterEach(() => {
        delete (window as any).XLSX;
        document.body.innerHTML = '';
        const styleEl = document.getElementById('omni-viewer-excel-styles');
        if (styleEl) styleEl.remove();
    });

    it('renders a Toggle View button in the toolbar', async () => {
        installXlsxMock([
            ['name', 'age'],
            ['Alice', 30]
        ]);
        const { mountExcelViewer } = await import('../templates/excel/js/excelViewerMain');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const handle = mountExcelViewer(fakeFile(), host);
        await flushAsync();

        const btn = host.querySelector<HTMLButtonElement>('#xv-toggleView');
        expect(btn).not.toBeNull();
        expect(btn?.textContent).toBe('Raw View');
        handle.dispose();
    });

    it('flips the table <-> raw <pre> visibility on click', async () => {
        installXlsxMock([
            ['n'],
            [1],
            [2]
        ]);
        const { mountExcelViewer } = await import('../templates/excel/js/excelViewerMain');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const handle = mountExcelViewer(fakeFile(), host);
        await flushAsync();

        // Sanity: workbook actually loaded — sheet info gets populated by
        // the orchestrator's `refresh()` after the async parse completes.
        const sheetInfo = host.querySelector<HTMLElement>('#xv-sheetInfo')!;
        // Fall back to extra waits up to a tight cap so this doesn't flake
        // on slower CI runners.
        for (let i = 0; i < 50 && sheetInfo.textContent !== 'Sheet1'; i++) {
            await new Promise<void>((r) => setTimeout(r, 10));
        }
        const err = host.querySelector<HTMLElement>('#xv-error');
        const loading = host.querySelector<HTMLElement>('#xv-loading');
        // eslint-disable-next-line no-console
        console.log('sheetInfo:', sheetInfo.textContent, 'XLSX:', !!(window as any).XLSX, 'err:', err?.textContent, 'loading:', loading?.style.display);
        expect(sheetInfo.textContent).toBe('Sheet1');

        const tableWrap = host.querySelector<HTMLElement>('#xv-tableWrapper')!;
        const rawWrap = host.querySelector<HTMLElement>('#xv-rawWrapper')!;
        const rawPre = host.querySelector<HTMLPreElement>('#xv-rawData')!;
        const btn = host.querySelector<HTMLButtonElement>('#xv-toggleView')!;

        // Initial: table visible, raw hidden.
        expect(tableWrap.style.display).not.toBe('none');
        expect(rawWrap.style.display).toBe('none');

        // Flip into raw.
        btn.click();
        expect(rawWrap.style.display).toBe('block');
        expect(tableWrap.style.display).toBe('none');
        expect(rawPre.textContent).toContain('"name": "Sheet1"');
        expect(rawPre.textContent).toContain('"rows"');

        // Flip back to table.
        btn.click();
        expect(rawWrap.style.display).toBe('none');
        expect(tableWrap.style.display).toBe('block');

        handle.dispose();
    });

    it('disables the search input in raw mode and re-enables it in table mode', async () => {
        installXlsxMock([
            ['n'],
            [1]
        ]);
        const { mountExcelViewer } = await import('../templates/excel/js/excelViewerMain');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const handle = mountExcelViewer(fakeFile(), host);
        await flushAsync();

        const search = host.querySelector<HTMLInputElement>('#xv-searchInput')!;
        const clearBtn = host.querySelector<HTMLButtonElement>('#xv-clearSearch')!;
        const toggleBtn = host.querySelector<HTMLButtonElement>('#xv-toggleView')!;

        // DoD: table mode keeps search live.
        expect(search.disabled).toBe(false);
        expect(clearBtn.disabled).toBe(false);

        // DoD: raw mode disables search.
        toggleBtn.click();
        expect(search.disabled).toBe(true);
        expect(clearBtn.disabled).toBe(true);
        expect(search.getAttribute('aria-disabled')).toBe('true');

        // Flip back: search re-enables.
        toggleBtn.click();
        expect(search.disabled).toBe(false);
        expect(clearBtn.disabled).toBe(false);
        expect(search.hasAttribute('aria-disabled')).toBe(false);

        handle.dispose();
    });

    it('preserves scroll position when toggling between views (DoD)', async () => {
        installXlsxMock([
            ['n'],
            ...Array.from({ length: 20 }, (_, i) => [i])
        ]);
        const { mountExcelViewer } = await import('../templates/excel/js/excelViewerMain');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const handle = mountExcelViewer(fakeFile(), host);
        await flushAsync();

        const tableWrap = host.querySelector<HTMLElement>('#xv-tableWrapper')!;
        const rawWrap = host.querySelector<HTMLElement>('#xv-rawWrapper')!;
        const toggleBtn = host.querySelector<HTMLButtonElement>('#xv-toggleView')!;

        // jsdom doesn't lay out the document so scrollTop is settable but
        // would normally clamp to 0. Stub it with a writable property so we
        // can verify the orchestrator both *reads* the table scroll and
        // *writes* it back on the return flip.
        let tableScroll = 0;
        let rawScroll = 0;
        Object.defineProperty(tableWrap, 'scrollTop', {
            configurable: true,
            get: () => tableScroll,
            set: (v: number) => { tableScroll = v; }
        });
        Object.defineProperty(rawWrap, 'scrollTop', {
            configurable: true,
            get: () => rawScroll,
            set: (v: number) => { rawScroll = v; }
        });

        // User scrolls the table down.
        tableScroll = 137;

        // Flip to raw -> table scroll-top should be remembered.
        toggleBtn.click();
        // First time into raw the saved scroll is null, so it falls back to 0.
        expect(rawScroll).toBe(0);

        // User scrolls the raw view too.
        rawScroll = 42;

        // Flip back -> table scroll restored to 137.
        toggleBtn.click();
        expect(tableScroll).toBe(137);

        // Flip into raw again -> raw scroll restored to 42.
        toggleBtn.click();
        expect(rawScroll).toBe(42);

        handle.dispose();
    });

    it('hides the pagination footer in raw mode and restores it in table mode', async () => {
        installXlsxMock([
            ['n'],
            ...Array.from({ length: 5 }, (_, i) => [i])
        ]);
        const { mountExcelViewer } = await import('../templates/excel/js/excelViewerMain');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const handle = mountExcelViewer(fakeFile(), host);
        await flushAsync();

        const pagination = host.querySelector<HTMLElement>('#xv-pagination')!;
        const toggleBtn = host.querySelector<HTMLButtonElement>('#xv-toggleView')!;

        // Pagination is shown in table view (totalRows > 0).
        expect(pagination.style.display).not.toBe('none');

        toggleBtn.click(); // -> raw
        expect(pagination.style.display).toBe('none');

        toggleBtn.click(); // -> table
        expect(pagination.style.display).not.toBe('none');

        handle.dispose();
    });
});
