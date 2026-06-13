// Dynamic loader for the SheetJS / xlsx UMD bundle shipped under
// `vendor/xlsx.full.min.js`. Returns a cached promise so multiple mounts
// reuse the same script tag.
//
// Why dynamic + UMD: SheetJS distributes a UMD bundle that attaches to
// `window.XLSX`. We can't `import xlsx from 'xlsx'` because the package
// isn't an npm dependency (issue #36 forbids new deps); instead we inject
// a `<script>` tag pointing at `chrome.runtime.getURL(...)` so MV3's
// `web_accessible_resources` (#6) gates the load correctly.

/* eslint-disable @typescript-eslint/no-explicit-any */

const VENDOR_PATH = 'vendor/xlsx.full.min.js';

interface XlsxGlobalWindow extends Window {
    XLSX?: any;
}

let pendingLoad: Promise<any> | undefined;

function resolveVendorUrl(relativePath: string): string {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
        try {
            return chrome.runtime.getURL(relativePath);
        } catch {
            // Outside extension origin — fall through.
        }
    }
    return relativePath;
}

export function loadXlsx(): Promise<any> {
    if (typeof window === 'undefined') {
        return Promise.reject(new Error('xlsx loader: window is not defined'));
    }
    const win = window as XlsxGlobalWindow;
    if (win.XLSX) return Promise.resolve(win.XLSX);
    if (pendingLoad) return pendingLoad;
    pendingLoad = new Promise<any>((resolve, reject) => {
        const url = resolveVendorUrl(VENDOR_PATH);
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => {
            const w = window as XlsxGlobalWindow;
            if (w.XLSX) {
                resolve(w.XLSX);
            } else {
                reject(new Error('xlsx loader: vendor bundle did not expose window.XLSX'));
            }
        };
        script.onerror = () => {
            pendingLoad = undefined;
            reject(new Error(`xlsx loader: failed to load ${url}`));
        };
        document.head.appendChild(script);
    });
    return pendingLoad;
}

export interface ParsedSheet {
    name: string;
    headers: string[];
    rows: (string | number | boolean | null)[][];
    totalRows: number;
    totalColumns: number;
}

export interface ParsedWorkbook {
    sheets: ParsedSheet[];
    sheetNames: string[];
}

export async function parseWorkbookFromFile(file: File): Promise<ParsedWorkbook> {
    const xlsx = await loadXlsx();
    const buf = await file.arrayBuffer();
    const wb = xlsx.read(new Uint8Array(buf), { type: 'array' });
    const sheetNames: string[] = wb.SheetNames || [];
    const sheets: ParsedSheet[] = sheetNames.map((name) => {
        const sheet = wb.Sheets[name];
        const aoa: any[][] = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null }) as any[][];
        const headers = (aoa[0] || []).map((cell) =>
            cell === null || cell === undefined ? '' : String(cell)
        );
        const dataRows = aoa.slice(1);
        const totalColumns = Math.max(headers.length, ...dataRows.map((r) => r.length), 0);
        return {
            name,
            headers,
            rows: dataRows,
            totalRows: dataRows.length,
            totalColumns
        };
    });
    return { sheets, sheetNames };
}
