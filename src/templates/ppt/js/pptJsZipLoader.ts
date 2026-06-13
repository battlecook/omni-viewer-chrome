// Dynamic loader for the JSZip UMD bundle shipped under
// `vendor/jszip.min.js`. Mirrors `wordDocxLoader.ts` and `excelLoader.ts`:
// returns a cached promise so multiple mounts reuse the same script tag,
// resolves to `window.JSZip`.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { PptxZip } from '../../../utils/pptxXmlParser';

const JSZIP_VENDOR_PATH = 'vendor/jszip.min.js';

interface JsZipGlobalWindow extends Window {
    JSZip?: any;
}

export interface PptxJsZipCtor {
    loadAsync(data: ArrayBuffer): Promise<PptxZip>;
}

let pendingLoad: Promise<PptxJsZipCtor> | undefined;

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
        script.onerror = () => reject(new Error(`ppt loader: failed to load ${url}`));
        document.head.appendChild(script);
    });
}

export function loadJsZip(): Promise<PptxJsZipCtor> {
    if (typeof window === 'undefined') {
        return Promise.reject(new Error('ppt loader: window is not defined'));
    }
    const win = window as JsZipGlobalWindow;
    if (win.JSZip) return Promise.resolve(win.JSZip as PptxJsZipCtor);
    if (pendingLoad) return pendingLoad;
    pendingLoad = (async () => {
        await injectScript(resolveVendorUrl(JSZIP_VENDOR_PATH));
        const w = window as JsZipGlobalWindow;
        if (!w.JSZip) {
            throw new Error('ppt loader: jszip vendor bundle did not expose window.JSZip');
        }
        return w.JSZip as PptxJsZipCtor;
    })();
    return pendingLoad.catch((err) => {
        pendingLoad = undefined;
        throw err;
    });
}
