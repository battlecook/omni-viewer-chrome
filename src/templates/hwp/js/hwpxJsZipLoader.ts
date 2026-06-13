// Lazy loader for `vendor/jszip.min.js` for the HWPX path. Issue #54.
//
// HWPX is a zip of XML; we reuse the same JSZip vendor bundle the word
// (#22) and ppt (#41) viewers ship. We mirror their loader pattern
// rather than depend on `wordDocxLoader.ts` so the HWPX path doesn't
// drag in docx-preview / xlsx as a side effect.
//
// Idempotent — concurrent mounts share the same in-flight promise.

/* eslint-disable @typescript-eslint/no-explicit-any */

const JSZIP_VENDOR_PATH = 'vendor/jszip.min.js';

interface JsZipGlobalWindow extends Window {
    JSZip?: any;
}

let pendingJsZipLoad: Promise<any> | undefined;

function resolveVendorUrl(relativePath: string): string {
    if (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.getURL === 'function'
    ) {
        try {
            return chrome.runtime.getURL(relativePath);
        } catch {
            // Outside extension origin — fall through to relative path.
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
        script.onerror = () =>
            reject(new Error(`hwpx loader: failed to load ${url}`));
        document.head.appendChild(script);
    });
}

/**
 * Resolve to the `JSZip` constructor exposed on `window.JSZip` after
 * loading `vendor/jszip.min.js`. Cached so repeated mounts don't
 * re-inject the script tag.
 */
export function loadJsZip(): Promise<any> {
    if (typeof window === 'undefined') {
        return Promise.reject(new Error('hwpx loader: window is not defined'));
    }
    const win = window as JsZipGlobalWindow;
    if (win.JSZip) return Promise.resolve(win.JSZip);
    if (pendingJsZipLoad) return pendingJsZipLoad;
    pendingJsZipLoad = (async () => {
        await injectScript(resolveVendorUrl(JSZIP_VENDOR_PATH));
        const w = window as JsZipGlobalWindow;
        if (!w.JSZip) {
            throw new Error('hwpx loader: jszip vendor bundle did not expose window.JSZip');
        }
        return w.JSZip;
    })();
    return pendingJsZipLoad.catch((err) => {
        pendingJsZipLoad = undefined;
        throw err;
    });
}

export function jszipVendorUrl(): string {
    return resolveVendorUrl(JSZIP_VENDOR_PATH);
}

/**
 * Test-only hook to clear the cached promise so success-path retests
 * see a fresh module.
 */
export function __resetHwpxJsZipLoaderForTests(): void {
    pendingJsZipLoad = undefined;
}
