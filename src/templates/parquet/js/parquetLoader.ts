// Lazy loader for the hyparquet ESM bundle (`vendor/hyparquet/index.js`).
// Issue #39.
//
// hyparquet is a pure-ESM library that exposes the Parquet metadata + row
// readers we need (`parquetMetadataAsync`, `parquetReadObjects`, …). The
// vendored copy in `vendor/hyparquet/` is loaded by dynamic `import()` at
// runtime; the URL is resolved through `chrome.runtime.getURL(...)` so the
// bundle is fetched from the extension origin (and therefore subject to
// our `web_accessible_resources` allowlist in manifest.json).
//
// Contract:
//   - `loadHyparquet()` is idempotent and returns a cached promise so
//     repeated mounts share a single module instance.
//   - `arrayBufferToAsyncBuffer(buf)` wraps an in-memory ArrayBuffer in
//     hyparquet's `AsyncBuffer` shape — `{ byteLength, slice(start, end) }`.
//   - `formatColumnType(physicalType, logicalType)` is a pure helper that
//     produces the human-readable type label for the schema panel. Pure
//     so it can be unit-tested without spinning up jsdom.
//   - `resolveVendorUrl(path)` is exported so unit tests can verify that
//     `chrome.runtime.getURL` is consulted before falling back to a plain
//     relative path. Mirrors the pattern in `templates/hwp/js/rhwpLoader.ts`
//     and `templates/pdf/...` so future refactors stay diff-friendly.
//
// Workers / progressive loading / size guards are deliberately out of
// scope here — those land in #41 / #42. The whole parse runs on the main
// thread for now (TODO marker added inside the orchestration layer).

/* eslint-disable @typescript-eslint/no-explicit-any */

const HYPARQUET_VENDOR_PATH = 'vendor/hyparquet/index.js';

/**
 * Subset of hyparquet's `AsyncBuffer`. Re-declared here so the orchestration
 * layer can stay typed without dragging in the full hyparquet `.d.ts` (which
 * lives next to the ESM bundle but is not the canonical type source —
 * hyparquet authors recommend installing the npm package for full types,
 * which we deliberately avoid per the "no new npm dependencies" guardrail).
 */
export interface AsyncBuffer {
    byteLength: number;
    slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer>;
}

/**
 * Subset of hyparquet's `SchemaElement` that the schema panel renders. We
 * only declare the fields the orchestration layer reads so a future
 * hyparquet upgrade does not break our build over an unrelated field.
 */
export interface ParquetSchemaElement {
    name: string;
    type?: string;
    repetition_type?: string;
    num_children?: number;
    converted_type?: string;
    logical_type?: { type: string; [k: string]: unknown };
    type_length?: number;
    scale?: number;
    precision?: number;
}

/**
 * Subset of hyparquet's `FileMetaData` we touch.
 */
export interface ParquetFileMetadata {
    version?: number;
    schema: ParquetSchemaElement[];
    num_rows: bigint;
    row_groups: Array<{
        num_rows: bigint;
        total_byte_size?: bigint;
    }>;
    created_by?: string;
    metadata_length?: number;
}

/**
 * The minimal shape of the hyparquet ESM module that the orchestration
 * layer touches. Re-declared (instead of imported) so the dynamic import
 * stays string-typed and webpack does not try to resolve it at bundle
 * time.
 */
export interface HyparquetModule {
    parquetMetadataAsync: (
        buf: AsyncBuffer,
        options?: Record<string, unknown>
    ) => Promise<ParquetFileMetadata>;
    parquetMetadata: (
        arrayBuffer: ArrayBuffer,
        options?: Record<string, unknown>
    ) => ParquetFileMetadata;
    parquetReadObjects: (options: {
        file: AsyncBuffer;
        metadata?: ParquetFileMetadata;
        columns?: string[];
        rowStart?: number;
        rowEnd?: number;
        utf8?: boolean;
        [k: string]: unknown;
    }) => Promise<Record<string, any>[]>;
    [k: string]: unknown;
}

/**
 * Resolve a vendor file to a URL the page can fetch / import. Mirrors the
 * resolver in `rhwpLoader.ts` so the dynamic import works both inside a
 * `chrome-extension://` origin and in a plain relative-path fallback (used
 * by tests and by non-extension hosts during local debugging).
 *
 * Exported for tests.
 */
export function resolveVendorUrl(relativePath: string): string {
    if (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.getURL === 'function'
    ) {
        try {
            return chrome.runtime.getURL(relativePath);
        } catch {
            // Outside extension origin — fall through to a relative path.
        }
    }
    return relativePath;
}

/**
 * Resolve the hyparquet ESM entry URL. Exported so the loader test can
 * pin the exact vendor path.
 */
export function hyparquetModuleUrl(): string {
    return resolveVendorUrl(HYPARQUET_VENDOR_PATH);
}

/**
 * Build the user-facing error message for the parquet error panel. Kept
 * pure (no DOM) so tests can assert against the exact wording without
 * spinning up jsdom.
 */
export function buildLoadErrorMessage(err: unknown): string {
    const detail =
        err instanceof Error
            ? err.message
            : typeof err === 'string'
                ? err
                : 'Unknown error';
    return `Couldn't load Parquet reader: ${detail}`;
}

let pendingLoad: Promise<HyparquetModule> | undefined;

/**
 * Load hyparquet as an ESM module via dynamic import. Idempotent —
 * repeated calls share the same promise.
 *
 * `webpackIgnore` keeps webpack from trying to resolve the dynamic import
 * at bundle time. The URL is a `chrome-extension://` URL at runtime,
 * which only the browser can resolve (and which webpack cannot rewrite).
 */
export function loadHyparquet(): Promise<HyparquetModule> {
    if (pendingLoad) return pendingLoad;
    pendingLoad = (async (): Promise<HyparquetModule> => {
        const moduleUrl = hyparquetModuleUrl();
        const mod = (await import(/* webpackIgnore: true */ moduleUrl)) as HyparquetModule;
        if (!mod || typeof mod.parquetMetadataAsync !== 'function') {
            throw new Error(
                'hyparquet loader: vendor bundle did not expose parquetMetadataAsync'
            );
        }
        if (typeof mod.parquetReadObjects !== 'function') {
            throw new Error(
                'hyparquet loader: vendor bundle did not expose parquetReadObjects'
            );
        }
        return mod;
    })();
    return pendingLoad.catch((err) => {
        // Drop the cached promise on failure so a later retry (e.g. user
        // hits "Refresh") can try again instead of seeing the sticky
        // failure on every subsequent mount.
        pendingLoad = undefined;
        throw err;
    });
}

/**
 * Test-only hook. Resets the cached promise so unit tests can exercise the
 * success path twice without leaking module state across tests.
 */
export function __resetHyparquetLoaderForTests(): void {
    pendingLoad = undefined;
}

/**
 * Wrap an in-memory ArrayBuffer into the `AsyncBuffer` shape hyparquet
 * expects. hyparquet calls `slice(start, end)` to fetch byte ranges; with
 * a fully-resident buffer this is just `ArrayBuffer.prototype.slice`.
 *
 * `slice(start, end?)` may return either an ArrayBuffer or a Promise; we
 * return the ArrayBuffer synchronously so hyparquet's `await` is a no-op.
 *
 * NOTE: For the 50 MB DoD case we hold the whole file in memory. The
 * progressive / chunked variant lands in #42; until then this is the
 * simplest correct implementation.
 */
export function arrayBufferToAsyncBuffer(buf: ArrayBuffer): AsyncBuffer {
    const byteLength = buf.byteLength;
    return {
        byteLength,
        slice(start: number, end?: number): ArrayBuffer {
            // Mirror the semantics of `Array.prototype.slice` for `end`:
            // `undefined` means "to the end of the buffer". hyparquet
            // already passes a defined `end` in practice, but matching
            // the standard contract avoids surprises.
            const stop = end === undefined ? byteLength : end;
            // Clamp to buffer bounds; ArrayBuffer.slice is forgiving but
            // we're explicit so the test layer can assert clamped values.
            const lo = Math.max(0, Math.min(start, byteLength));
            const hi = Math.max(lo, Math.min(stop, byteLength));
            return buf.slice(lo, hi);
        },
    };
}

/**
 * Format a column's type for the schema panel. Pure helper — exported so
 * the orchestration layer stays declarative and so tests can pin the
 * exact label without spinning up the renderer.
 *
 * Strategy:
 *   - If a logical type is present (the modern Parquet metadata path),
 *     prefer it: it's the most user-meaningful label (e.g. "STRING",
 *     "TIMESTAMP(MICROS, UTC)", "DECIMAL(10, 2)").
 *   - Otherwise fall back to the physical type (e.g. "INT32", "DOUBLE").
 *   - If neither is set (nested group nodes), return "GROUP".
 *
 * The exact label shape is not load-bearing for any other module; the
 * schema panel just renders the string.
 */
export function formatColumnType(
    physicalType: string | undefined,
    logicalType: { type: string; [k: string]: unknown } | undefined
): string {
    if (logicalType && typeof logicalType.type === 'string') {
        const t = logicalType.type;
        // Decorate a few common parameterised types so the user sees the
        // actual precision / unit instead of just "DECIMAL". The set is
        // intentionally small — we mirror exactly the parameters the
        // hyparquet `LogicalType` union declares for these variants.
        if (t === 'DECIMAL') {
            const precision = (logicalType as { precision?: number }).precision;
            const scale = (logicalType as { scale?: number }).scale;
            if (typeof precision === 'number' && typeof scale === 'number') {
                return `DECIMAL(${precision}, ${scale})`;
            }
            return 'DECIMAL';
        }
        if (t === 'TIMESTAMP' || t === 'TIME') {
            const unit = (logicalType as { unit?: string }).unit;
            const utc = (logicalType as { isAdjustedToUTC?: boolean }).isAdjustedToUTC;
            const parts: string[] = [];
            if (typeof unit === 'string') parts.push(unit);
            if (utc === true) parts.push('UTC');
            return parts.length > 0 ? `${t}(${parts.join(', ')})` : t;
        }
        if (t === 'INTEGER') {
            const bitWidth = (logicalType as { bitWidth?: number }).bitWidth;
            const isSigned = (logicalType as { isSigned?: boolean }).isSigned;
            if (typeof bitWidth === 'number') {
                const sign = isSigned === false ? 'UINT' : 'INT';
                return `${sign}${bitWidth}`;
            }
            return 'INTEGER';
        }
        return t;
    }
    if (physicalType) {
        return physicalType;
    }
    return 'GROUP';
}
