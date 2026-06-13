// Dynamic loader for the docx-preview UMD bundle shipped under
// `vendor/docx-preview.min.js`. docx-preview depends on JSZip, which
// must be loaded first (it looks up `window.JSZip`).
//
// Returns cached promises so multiple mounts reuse the same script
// tags. Mirrors the pattern used by `excelLoader.ts` (issue #36) and
// `xlsx`/`yaml`/`pdf` loaders so MV3's `web_accessible_resources`
// gating handles the load consistently.

/* eslint-disable @typescript-eslint/no-explicit-any */

const DOCX_VENDOR_PATH = 'vendor/docx-preview.min.js';
const JSZIP_VENDOR_PATH = 'vendor/jszip.min.js';
const XLSX_VENDOR_PATH = 'vendor/xlsx.full.min.js';

interface DocxGlobalWindow extends Window {
    docx?: any;
    JSZip?: any;
    XLSX?: any;
}

let pendingJsZipLoad: Promise<any> | undefined;
let pendingDocxLoad: Promise<any> | undefined;
let pendingXlsxLoad: Promise<any> | undefined;

function resolveVendorUrl(relativePath: string): string {
    if (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.getURL === 'function'
    ) {
        try {
            return chrome.runtime.getURL(relativePath);
        } catch {
            // Outside extension origin — fall through to the relative path.
        }
    }
    return relativePath;
}

function injectScript(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = false; // preserve execution order across our two scripts
        script.onload = () => resolve();
        script.onerror = () =>
            reject(new Error(`word loader: failed to load ${url}`));
        document.head.appendChild(script);
    });
}

export function loadJsZip(): Promise<any> {
    if (typeof window === 'undefined') {
        return Promise.reject(new Error('word loader: window is not defined'));
    }
    const win = window as DocxGlobalWindow;
    if (win.JSZip) return Promise.resolve(win.JSZip);
    if (pendingJsZipLoad) return pendingJsZipLoad;
    pendingJsZipLoad = (async () => {
        await injectScript(resolveVendorUrl(JSZIP_VENDOR_PATH));
        const w = window as DocxGlobalWindow;
        if (!w.JSZip) {
            throw new Error(
                'word loader: jszip vendor bundle did not expose window.JSZip'
            );
        }
        return w.JSZip;
    })();
    return pendingJsZipLoad.catch((err) => {
        pendingJsZipLoad = undefined;
        throw err;
    });
}

/**
 * Lazily load SheetJS (`window.XLSX`) for issue #45's embedded
 * workbook preview. Re-uses the same vendor bundle the excel viewer
 * loads — we keep a separate cached promise here so the word viewer's
 * loader module owns all of its vendor dependencies in one place.
 */
export function loadXlsxLib(): Promise<any> {
    if (typeof window === 'undefined') {
        return Promise.reject(new Error('word loader: window is not defined'));
    }
    const win = window as DocxGlobalWindow;
    if (win.XLSX) return Promise.resolve(win.XLSX);
    if (pendingXlsxLoad) return pendingXlsxLoad;
    pendingXlsxLoad = (async () => {
        await injectScript(resolveVendorUrl(XLSX_VENDOR_PATH));
        const w = window as DocxGlobalWindow;
        if (!w.XLSX) {
            throw new Error(
                'word loader: xlsx vendor bundle did not expose window.XLSX'
            );
        }
        return w.XLSX;
    })();
    return pendingXlsxLoad.catch((err) => {
        pendingXlsxLoad = undefined;
        throw err;
    });
}

export function loadDocxPreview(): Promise<any> {
    if (typeof window === 'undefined') {
        return Promise.reject(new Error('word loader: window is not defined'));
    }
    const win = window as DocxGlobalWindow;
    if (win.docx) return Promise.resolve(win.docx);
    if (pendingDocxLoad) return pendingDocxLoad;
    pendingDocxLoad = (async () => {
        // docx-preview reads from window.JSZip, so make sure it's there first.
        await loadJsZip();
        await injectScript(resolveVendorUrl(DOCX_VENDOR_PATH));
        const w = window as DocxGlobalWindow;
        if (!w.docx) {
            throw new Error(
                'word loader: docx-preview vendor bundle did not expose window.docx'
            );
        }
        return w.docx;
    })();
    return pendingDocxLoad.catch((err) => {
        pendingDocxLoad = undefined;
        throw err;
    });
}
