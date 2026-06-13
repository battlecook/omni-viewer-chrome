/**
 * Unit tests for the hyparquet lazy-loader helpers in
 * `templates/parquet/js/parquetLoader.ts` (issue #39).
 *
 * These tests cover the pure helpers — vendor URL resolution, AsyncBuffer
 * wrapper construction, and the column-type formatter the schema panel
 * uses. The actual hyparquet ESM import can't run in jsdom (it uses
 * dynamic `import()` against a `chrome-extension://` URL plus pure-ESM
 * imports that ts-jest cannot transform on the fly), so the real load
 * path is exercised manually per the issue's "real Parquet integration
 * is manual-tested with 1 MB / 50 MB files" note.
 */

import {
    arrayBufferToAsyncBuffer,
    buildLoadErrorMessage,
    formatColumnType,
    hyparquetModuleUrl,
    resolveVendorUrl,
} from '../templates/parquet/js/parquetLoader';

describe('parquetLoader.resolveVendorUrl', () => {
    it('prefers chrome.runtime.getURL when available', () => {
        const url = resolveVendorUrl('vendor/hyparquet/index.js');
        expect(url).toBe(
            'chrome-extension://omni-viewer-test/vendor/hyparquet/index.js'
        );
    });

    it('falls back to the relative path when getURL throws', () => {
        const original = chrome.runtime.getURL;
        const throwing = jest.fn((_path: string) => {
            throw new Error('not in extension origin');
        }) as unknown as typeof chrome.runtime.getURL;
        chrome.runtime.getURL = throwing;
        try {
            expect(resolveVendorUrl('vendor/hyparquet/index.js')).toBe(
                'vendor/hyparquet/index.js'
            );
        } finally {
            chrome.runtime.getURL = original;
        }
    });

    it('falls back to the relative path when chrome is undefined', () => {
        const globalAny = globalThis as unknown as { chrome?: unknown };
        const saved = globalAny.chrome;
        delete globalAny.chrome;
        try {
            expect(resolveVendorUrl('vendor/hyparquet/index.js')).toBe(
                'vendor/hyparquet/index.js'
            );
        } finally {
            globalAny.chrome = saved;
        }
    });
});

describe('parquetLoader.hyparquetModuleUrl', () => {
    it('resolves vendor/hyparquet/index.js', () => {
        expect(hyparquetModuleUrl()).toBe(
            'chrome-extension://omni-viewer-test/vendor/hyparquet/index.js'
        );
    });

    it('points at the ESM entry hyparquet ships from the vendor dir', () => {
        // Sanity check: the path ends in `index.js`, the ESM entry the
        // hyparquet package.json declares. A future vendor refresh that
        // splits the bundle would need to keep an `index.js` shim or
        // update this helper in lockstep.
        const url = hyparquetModuleUrl();
        expect(url.endsWith('/vendor/hyparquet/index.js')).toBe(true);
    });
});

describe('parquetLoader.arrayBufferToAsyncBuffer', () => {
    it('reports the underlying ArrayBuffer byteLength', () => {
        const buf = new ArrayBuffer(1024);
        const ab = arrayBufferToAsyncBuffer(buf);
        expect(ab.byteLength).toBe(1024);
    });

    it('slices return ArrayBuffers of the requested range', () => {
        const buf = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer;
        const ab = arrayBufferToAsyncBuffer(buf);
        const sliced = ab.slice(2, 6);
        // The synchronous path is what hyparquet relies on at the hot
        // metadata-fetch path; we deliberately do NOT wrap in a Promise
        // so `await asyncBuffer.slice(...)` is a no-op.
        expect(sliced).toBeInstanceOf(ArrayBuffer);
        const arr = new Uint8Array(sliced as ArrayBuffer);
        expect(Array.from(arr)).toEqual([2, 3, 4, 5]);
    });

    it('treats undefined `end` as "to the end of the buffer"', () => {
        const buf = new Uint8Array([10, 20, 30, 40]).buffer;
        const ab = arrayBufferToAsyncBuffer(buf);
        const sliced = ab.slice(1) as ArrayBuffer;
        expect(Array.from(new Uint8Array(sliced))).toEqual([20, 30, 40]);
    });

    it('clamps out-of-range start/end to the buffer bounds', () => {
        const buf = new Uint8Array([1, 2, 3, 4]).buffer;
        const ab = arrayBufferToAsyncBuffer(buf);
        const sliced = ab.slice(-100, 9999) as ArrayBuffer;
        expect(Array.from(new Uint8Array(sliced))).toEqual([1, 2, 3, 4]);
    });

    it('returns an empty buffer when start >= end', () => {
        const buf = new Uint8Array([1, 2, 3]).buffer;
        const ab = arrayBufferToAsyncBuffer(buf);
        const sliced = ab.slice(2, 1) as ArrayBuffer;
        expect(sliced.byteLength).toBe(0);
    });

    it('matches the hyparquet AsyncBuffer shape (byteLength + slice)', () => {
        // Pin the exact surface so a future change can't accidentally
        // drop a property hyparquet calls. The hyparquet types declare
        // exactly `{ byteLength, slice(start, end?) }` and nothing else.
        const buf = new ArrayBuffer(4);
        const ab = arrayBufferToAsyncBuffer(buf);
        expect(typeof ab.byteLength).toBe('number');
        expect(typeof ab.slice).toBe('function');
        // slice should accept (start) and (start, end) — verify the
        // arity isn't accidentally restricted.
        expect(ab.slice.length).toBeGreaterThanOrEqual(1);
    });
});

describe('parquetLoader.formatColumnType', () => {
    it('prefers the logical type when present', () => {
        expect(formatColumnType('BYTE_ARRAY', { type: 'STRING' })).toBe('STRING');
    });

    it('falls back to the physical type when logical type is missing', () => {
        expect(formatColumnType('INT32', undefined)).toBe('INT32');
    });

    it('returns "GROUP" when neither type is set', () => {
        // Group nodes in the flat schema list have no `type` and no
        // `logical_type`; the schema panel still renders them so the user
        // sees nested structure.
        expect(formatColumnType(undefined, undefined)).toBe('GROUP');
    });

    it('expands DECIMAL with precision and scale', () => {
        expect(
            formatColumnType('FIXED_LEN_BYTE_ARRAY', {
                type: 'DECIMAL',
                precision: 10,
                scale: 2,
            })
        ).toBe('DECIMAL(10, 2)');
    });

    it('returns plain DECIMAL when precision/scale are absent', () => {
        expect(
            formatColumnType('FIXED_LEN_BYTE_ARRAY', { type: 'DECIMAL' })
        ).toBe('DECIMAL');
    });

    it('expands TIMESTAMP with unit and UTC adjustment', () => {
        expect(
            formatColumnType('INT64', {
                type: 'TIMESTAMP',
                unit: 'MICROS',
                isAdjustedToUTC: true,
            })
        ).toBe('TIMESTAMP(MICROS, UTC)');
    });

    it('expands TIMESTAMP without UTC adjustment', () => {
        expect(
            formatColumnType('INT64', {
                type: 'TIMESTAMP',
                unit: 'MILLIS',
                isAdjustedToUTC: false,
            })
        ).toBe('TIMESTAMP(MILLIS)');
    });

    it('expands TIME with unit', () => {
        expect(
            formatColumnType('INT32', {
                type: 'TIME',
                unit: 'MILLIS',
                isAdjustedToUTC: false,
            })
        ).toBe('TIME(MILLIS)');
    });

    it('renders signed INTEGER as INT<bitWidth>', () => {
        expect(
            formatColumnType('INT32', { type: 'INTEGER', bitWidth: 16, isSigned: true })
        ).toBe('INT16');
    });

    it('renders unsigned INTEGER as UINT<bitWidth>', () => {
        expect(
            formatColumnType('INT32', { type: 'INTEGER', bitWidth: 32, isSigned: false })
        ).toBe('UINT32');
    });

    it('returns plain INTEGER when bitWidth is missing', () => {
        expect(formatColumnType('INT32', { type: 'INTEGER' })).toBe('INTEGER');
    });

    it('passes simple logical types through unchanged', () => {
        expect(formatColumnType('BYTE_ARRAY', { type: 'JSON' })).toBe('JSON');
        expect(formatColumnType('FIXED_LEN_BYTE_ARRAY', { type: 'UUID' })).toBe('UUID');
    });
});

describe('parquetLoader.buildLoadErrorMessage', () => {
    it('extracts .message from Error instances', () => {
        const err = new Error('Network failed');
        expect(buildLoadErrorMessage(err)).toBe(
            "Couldn't load Parquet reader: Network failed"
        );
    });

    it('passes string errors through directly', () => {
        expect(buildLoadErrorMessage('boom')).toBe(
            "Couldn't load Parquet reader: boom"
        );
    });

    it('falls back to a stable label for non-Error / non-string values', () => {
        expect(buildLoadErrorMessage(undefined)).toBe(
            "Couldn't load Parquet reader: Unknown error"
        );
        expect(buildLoadErrorMessage(null)).toBe(
            "Couldn't load Parquet reader: Unknown error"
        );
        expect(buildLoadErrorMessage({ weird: true })).toBe(
            "Couldn't load Parquet reader: Unknown error"
        );
    });

    it('always begins with the stable user-facing prefix', () => {
        // The orchestration layer relies on this exact prefix when
        // rendering the error panel. Pin it so a future tweak to the
        // message body does not silently drop the prefix.
        expect(buildLoadErrorMessage(new Error('x'))).toMatch(
            /^Couldn't load Parquet reader:/
        );
    });
});
