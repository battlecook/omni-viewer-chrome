// Lazy loader for the pdf-lib UMD bundle shipped under
// `vendor/pdf-lib.min.js`. Mirrors `pptJsZipLoader.ts` /
// `wordDocxLoader.ts`: returns a cached promise so multiple callers (Save,
// Save As, Merge, ...) share the same script tag, and resolves to the
// global `window.PDFLib` exposed by the UMD bundle.
//
// Why lazy: pdf-lib is multi-hundred-KB. Issue #16 only needs pdf.js for
// rendering; pdf-lib is only required when the user actually merges or
// saves. Loading on demand keeps the initial PDF-open cost flat.

/* eslint-disable @typescript-eslint/no-explicit-any */

const PDF_LIB_VENDOR_PATH = 'vendor/pdf-lib.min.js';

/**
 * Subset of the pdf-lib API we rely on. We only declare what the save /
 * merge code paths use so a future pdf-lib upgrade doesn't drag in a
 * full-fidelity type port.
 */
export interface PdfLibPage {
    getWidth(): number;
    getHeight(): number;
    drawText(text: string, options: {
        x: number;
        y: number;
        size: number;
        font?: any;
        color?: any;
    }): void;
    drawImage(image: any, options: {
        x: number;
        y: number;
        width: number;
        height: number;
    }): void;
}

export interface PdfLibDocument {
    getPages(): PdfLibPage[];
    getPageCount(): number;
    addPage(page?: any): any;
    copyPages(srcDoc: PdfLibDocument, indices: number[]): Promise<any[]>;
    embedFont(font: any): Promise<any>;
    embedPng(bytes: ArrayBuffer | Uint8Array): Promise<any>;
    save(options?: { useObjectStreams?: boolean }): Promise<Uint8Array>;
}

export interface PdfLibStandardFonts {
    Helvetica: any;
    [k: string]: any;
}

export interface PdfLibNamespace {
    PDFDocument: {
        load(bytes: ArrayBuffer | Uint8Array): Promise<PdfLibDocument>;
        create(): Promise<PdfLibDocument>;
    };
    StandardFonts: PdfLibStandardFonts;
    rgb(r: number, g: number, b: number): any;
}

interface PdfLibGlobalWindow extends Window {
    PDFLib?: PdfLibNamespace;
}

let pendingLoad: Promise<PdfLibNamespace> | undefined;

function resolveVendorUrl(relativePath: string): string {
    if (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.getURL === 'function'
    ) {
        try {
            return chrome.runtime.getURL(relativePath);
        } catch {
            // Outside extension origin — fall through.
        }
    }
    return relativePath;
}

function injectScript(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = false;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`pdf-lib loader: failed to load ${url}`));
        document.head.appendChild(script);
    });
}

/**
 * Load the pdf-lib UMD bundle. Idempotent: returns the same promise on
 * concurrent calls and short-circuits when `window.PDFLib` is already
 * populated (e.g. another mount in the same tab).
 */
export function loadPdfLib(): Promise<PdfLibNamespace> {
    if (typeof window === 'undefined') {
        return Promise.reject(new Error('pdf-lib loader: window is not defined'));
    }
    const win = window as PdfLibGlobalWindow;
    if (win.PDFLib) return Promise.resolve(win.PDFLib);
    if (pendingLoad) return pendingLoad;
    pendingLoad = (async () => {
        await injectScript(resolveVendorUrl(PDF_LIB_VENDOR_PATH));
        const w = window as PdfLibGlobalWindow;
        if (!w.PDFLib) {
            throw new Error(
                'pdf-lib loader: vendor bundle did not expose window.PDFLib'
            );
        }
        return w.PDFLib;
    })();
    return pendingLoad.catch((err) => {
        // Reset on failure so a later retry can try again.
        pendingLoad = undefined;
        throw err;
    });
}
