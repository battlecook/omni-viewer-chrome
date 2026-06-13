// Unit tests for the PSD viewer's pure helpers (issue #50).
//
// Coverage:
//   - `isPsdSizeAcceptable` honors the 200 MB memory gate boundary
//     exactly: at the limit it allows, one byte over rejects, negative /
//     non-finite is rejected.
//   - `buildPsdSizeRejectionMessage` emits a human-readable message that
//     mentions both the offending size and the 200 MB cap.
//   - `formatColorMode` maps the canonical Photoshop color-mode codes
//     to readable labels and falls back to a stable string for unknown
//     codes (so the metadata bar stays informative even when ag-psd
//     surfaces a value we haven't pinned).
//
// These helpers are pure — no DOM, no ag-psd, no async. The DOM-driven
// orchestration in `psdViewerMain.ts` is exercised manually per the
// issue DoD ("various PSDs render correctly via composite") and is left
// out of unit testing because it depends on the vendor bundle being
// present at runtime, which is not the case in CI yet (see issue #50
// PR notes for the vendor-bundle deferral).

import {
    PSD_MEMORY_GATE_BYTES,
    buildPsdSizeRejectionMessage,
    formatColorMode,
    isPsdSizeAcceptable
} from '../templates/psd/js/psdLoader';

describe('PSD_MEMORY_GATE_BYTES', () => {
    it('is exactly 200 MiB', () => {
        expect(PSD_MEMORY_GATE_BYTES).toBe(200 * 1024 * 1024);
    });
});

describe('isPsdSizeAcceptable', () => {
    it('accepts 0-byte files (the parser will fail later, not the gate)', () => {
        expect(isPsdSizeAcceptable(0)).toBe(true);
    });

    it('accepts a typical PSD well under the cap', () => {
        // 25 MiB
        expect(isPsdSizeAcceptable(25 * 1024 * 1024)).toBe(true);
    });

    it('accepts a file at exactly the 200 MiB limit', () => {
        expect(isPsdSizeAcceptable(PSD_MEMORY_GATE_BYTES)).toBe(true);
    });

    it('rejects a file one byte past the limit', () => {
        expect(isPsdSizeAcceptable(PSD_MEMORY_GATE_BYTES + 1)).toBe(false);
    });

    it('rejects a comfortably-oversized file', () => {
        // 500 MiB
        expect(isPsdSizeAcceptable(500 * 1024 * 1024)).toBe(false);
    });

    it('rejects negative sizes (defensive)', () => {
        expect(isPsdSizeAcceptable(-1)).toBe(false);
    });

    it('rejects non-finite sizes (defensive)', () => {
        expect(isPsdSizeAcceptable(Number.POSITIVE_INFINITY)).toBe(false);
        expect(isPsdSizeAcceptable(Number.NaN)).toBe(false);
    });
});

describe('buildPsdSizeRejectionMessage', () => {
    it('mentions the actual size in MB', () => {
        const msg = buildPsdSizeRejectionMessage(250 * 1024 * 1024);
        expect(msg).toContain('250');
        expect(msg).toContain('MB');
    });

    it('mentions the 200 MB cap', () => {
        const msg = buildPsdSizeRejectionMessage(300 * 1024 * 1024);
        expect(msg).toContain('200');
    });

    it('uses one decimal place for sizes under 100 MB', () => {
        // 50.5 MiB should appear as "50.5"
        const msg = buildPsdSizeRejectionMessage(Math.round(50.5 * 1024 * 1024));
        expect(msg).toMatch(/50\.5/);
    });

    it('uses no decimals for sizes at or above 100 MB', () => {
        const msg = buildPsdSizeRejectionMessage(250 * 1024 * 1024);
        // No "250.0" form
        expect(msg).not.toMatch(/250\.0/);
        expect(msg).toMatch(/250 MB/);
    });
});

describe('formatColorMode', () => {
    it('maps the canonical Photoshop color-mode codes', () => {
        expect(formatColorMode(0)).toBe('Bitmap');
        expect(formatColorMode(1)).toBe('Grayscale');
        expect(formatColorMode(2)).toBe('Indexed');
        expect(formatColorMode(3)).toBe('RGB');
        expect(formatColorMode(4)).toBe('CMYK');
        expect(formatColorMode(7)).toBe('Multichannel');
        expect(formatColorMode(8)).toBe('Duotone');
        expect(formatColorMode(9)).toBe('Lab');
    });

    it('returns a stable fallback for unknown integer codes', () => {
        expect(formatColorMode(42)).toBe('Mode 42');
    });

    it('returns "Unknown" for missing values', () => {
        expect(formatColorMode(undefined)).toBe('Unknown');
    });

    it('returns "Unknown" for non-finite codes (defensive)', () => {
        expect(formatColorMode(Number.NaN)).toBe('Unknown');
        expect(formatColorMode(Number.POSITIVE_INFINITY)).toBe('Unknown');
    });
});
