/**
 * Unit tests for the rhwp WASM lazy-loader helpers in
 * `templates/hwp/js/rhwpLoader.ts` (issue #53).
 *
 * These tests cover the pure helpers — the path resolution that decides
 * where the bundle / WASM file are loaded from, and the user-facing
 * error message construction. The real WASM init can't run in jsdom
 * (no real WebAssembly streaming + the rhwp bundle uses dynamic
 * `import()` against a `chrome-extension://` URL), so the actual
 * `loadRhwp()` path is exercised manually per the issue's "real WASM
 * integration is manual-tested" note.
 */

import {
    resolveVendorUrl,
    rhwpModuleUrl,
    rhwpWasmUrl,
    buildLoadErrorMessage,
} from '../templates/hwp/js/rhwpLoader';

describe('rhwpLoader.resolveVendorUrl', () => {
    it('prefers chrome.runtime.getURL when available', () => {
        const url = resolveVendorUrl('vendor/rhwp.js');
        expect(url).toBe('chrome-extension://omni-viewer-test/vendor/rhwp.js');
    });

    it('falls back to the relative path when getURL throws', () => {
        const original = chrome.runtime.getURL;
        const throwing = jest.fn((_path: string) => {
            throw new Error('not in extension origin');
        }) as unknown as typeof chrome.runtime.getURL;
        chrome.runtime.getURL = throwing;
        try {
            expect(resolveVendorUrl('vendor/rhwp.js')).toBe('vendor/rhwp.js');
        } finally {
            chrome.runtime.getURL = original;
        }
    });

    it('falls back to the relative path when chrome is undefined', () => {
        const globalAny = globalThis as unknown as { chrome?: unknown };
        const saved = globalAny.chrome;
        delete globalAny.chrome;
        try {
            expect(resolveVendorUrl('vendor/rhwp.js')).toBe('vendor/rhwp.js');
        } finally {
            globalAny.chrome = saved;
        }
    });
});

describe('rhwpLoader vendor URL helpers', () => {
    it('rhwpModuleUrl resolves vendor/rhwp.js', () => {
        expect(rhwpModuleUrl()).toBe(
            'chrome-extension://omni-viewer-test/vendor/rhwp.js'
        );
    });

    it('rhwpWasmUrl resolves vendor/rhwp_bg.wasm (WASM locateFile equivalent)', () => {
        // This is the URL we hand to wasm-bindgen's __wbg_init, which
        // is the rhwp equivalent of the Emscripten `locateFile` hook
        // called out in the issue description.
        expect(rhwpWasmUrl()).toBe(
            'chrome-extension://omni-viewer-test/vendor/rhwp_bg.wasm'
        );
    });

    it('the WASM URL sits next to the JS bundle URL', () => {
        // Sanity check: the WASM and JS live in the same vendor
        // directory; a future refactor that splits them would need
        // to update both helpers in lockstep.
        const moduleUrl = rhwpModuleUrl();
        const wasmUrl = rhwpWasmUrl();
        const moduleDir = moduleUrl.replace(/[^/]+$/, '');
        const wasmDir = wasmUrl.replace(/[^/]+$/, '');
        expect(moduleDir).toBe(wasmDir);
    });
});

describe('rhwpLoader.buildLoadErrorMessage', () => {
    it('extracts .message from Error instances', () => {
        const err = new Error('WebAssembly.compile failed');
        expect(buildLoadErrorMessage(err)).toBe(
            "Couldn't load HWP renderer: WebAssembly.compile failed"
        );
    });

    it('passes string errors through directly', () => {
        expect(buildLoadErrorMessage('boom')).toBe(
            "Couldn't load HWP renderer: boom"
        );
    });

    it('falls back to a stable label for non-Error / non-string values', () => {
        expect(buildLoadErrorMessage(undefined)).toBe(
            "Couldn't load HWP renderer: Unknown error"
        );
        expect(buildLoadErrorMessage(null)).toBe(
            "Couldn't load HWP renderer: Unknown error"
        );
        expect(buildLoadErrorMessage({ weird: true })).toBe(
            "Couldn't load HWP renderer: Unknown error"
        );
    });

    it('always begins with the stable user-facing prefix', () => {
        // The orchestration layer relies on this exact prefix when
        // rendering the error panel (DoD: "Couldn't load HWP
        // renderer"). Pin it so a future tweak to the message body
        // does not silently drop the prefix.
        expect(buildLoadErrorMessage(new Error('x'))).toMatch(
            /^Couldn't load HWP renderer:/
        );
    });
});
