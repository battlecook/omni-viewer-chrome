// Pure size-guard helpers for the Chrome Parquet viewer (issue #41).
//
// Determines how aggressively we should guard a parquet file based on its
// byte size. Three buckets:
//   - `small`   (<50 MB)  : load freely, "Load more" optional.
//   - `limited` (50-150MB): load 10k rows + show a warning panel + offer a
//                            "Load more" button (which then uses the #42
//                            progressive-loader path).
//   - `blocked` (>=150MB) : refuse to load inline; the viewer presents a
//                            friendly panel with a Download button.
//
// Boundaries are inclusive on the lower edge:
//   bytes < PARQUET_LIMIT_THRESHOLD_BYTES                          -> small
//   PARQUET_LIMIT_THRESHOLD_BYTES <= bytes < PARQUET_BLOCK_THRESHOLD_BYTES -> limited
//   bytes >= PARQUET_BLOCK_THRESHOLD_BYTES                         -> blocked
//
// Kept DOM-less so the helpers are unit-testable without jsdom.

/** 50 MiB — start showing the "limited preview" warning. */
export const PARQUET_LIMIT_THRESHOLD_BYTES = 50 * 1024 * 1024;

/** 150 MiB — refuse to render inline. */
export const PARQUET_BLOCK_THRESHOLD_BYTES = 150 * 1024 * 1024;

export type ParquetSizeBucket = 'small' | 'limited' | 'blocked';

/**
 * Map a file's byte length to its size bucket.
 *
 * Negative or non-finite inputs are treated as `small` defensively — a
 * pathological reader that forwards `-1` should not block the user.
 */
export function parquetSizeBucket(bytes: number): ParquetSizeBucket {
    if (!Number.isFinite(bytes) || bytes < 0) return 'small';
    if (bytes >= PARQUET_BLOCK_THRESHOLD_BYTES) return 'blocked';
    if (bytes >= PARQUET_LIMIT_THRESHOLD_BYTES) return 'limited';
    return 'small';
}

/**
 * Build the body text for the limited-preview warning. Pure helper so the
 * exact phrasing can be pinned by a unit test.
 *
 * Examples:
 *   formatLimitMessage(10000, 250000n)
 *     -> "Showing 10,000 of 250,000 rows. Load more to see additional rows."
 *
 *   formatLimitMessage(250000, 250000n)
 *     -> "All 250,000 rows loaded."
 */
export function formatLimitMessage(
    loaded: number,
    total: bigint | number
): string {
    const totalBig = typeof total === 'bigint' ? total : BigInt(Math.max(0, Math.trunc(total)));
    const loadedSafe = Math.max(0, Math.trunc(loaded));
    const loadedFmt = loadedSafe.toLocaleString('en-US');
    const totalFmt = formatBigInt(totalBig);
    if (BigInt(loadedSafe) >= totalBig) {
        return `All ${totalFmt} rows loaded.`;
    }
    return `Showing ${loadedFmt} of ${totalFmt} rows. Load more to see additional rows.`;
}

/**
 * Build the headline + detail copy for the "blocked" panel (file >= 150MB).
 * Returned as a struct so the renderer can decorate the headline + body
 * separately (different font weights / colors).
 */
export function formatBlockedMessage(bytes: number): {
    headline: string;
    detail: string;
} {
    const sizeMB = (bytes / (1024 * 1024)).toFixed(1);
    return {
        headline: 'File too large to open inline',
        detail:
            `This Parquet file is ${sizeMB} MB. Inline preview is disabled ` +
            `for files at or above ${PARQUET_BLOCK_THRESHOLD_BYTES / (1024 * 1024)} MB. ` +
            `Use a desktop tool (DuckDB, Apache Arrow, pandas) to inspect it.`,
    };
}

/**
 * Format a bigint with thousands-separator grouping (en-US style). Falls back
 * to plain decimal if `Intl.NumberFormat` cannot accept BigInt on the host
 * runtime (older jsdom versions).
 */
function formatBigInt(value: bigint): string {
    try {
        return new Intl.NumberFormat('en-US').format(value);
    } catch {
        // Manual grouping — walk the digits in reverse and insert commas.
        const digits = value.toString();
        const negative = digits.startsWith('-');
        const body = negative ? digits.slice(1) : digits;
        const groups: string[] = [];
        for (let i = body.length; i > 0; i -= 3) {
            groups.unshift(body.slice(Math.max(0, i - 3), i));
        }
        return (negative ? '-' : '') + groups.join(',');
    }
}
