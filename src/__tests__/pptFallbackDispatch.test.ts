// Tests for issue #79's specific-error-message dispatch and the pdf.js
// mode hook smoke test.
//
// We exercise the public surface only — neither `mountPptViewer` (DOM
// orchestration with side-effects) nor `renderPdfSlides` (network-style
// pdf.js bootstrap) is invoked directly. Instead we assert:
//
//   - the i18n keys exist in `_locales/en/messages.json`, and
//   - the helper functions exported from `pptxXmlParser.ts` /
//     `pptBinaryParser.ts` behave correctly under the same simulated
//     conditions the production dispatch site uses to decide which key
//     to surface (parser failure / no-renderable / browser-side
//     failure).
//
// The `renderPdfSlides` smoke test confirms the module is importable
// and the exported function is callable — pdf.js is loaded lazily, so
// invoking the function under jsdom without a real PDF byte stream
// returns the empty handle without touching the network.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    extractLooseTextFromCfb
} from '../utils/pptBinaryParser';
import {
    countPptxRenderableShapes,
    extractPptxFallbackText
} from '../utils/pptxXmlParser';
import { renderPdfSlides } from '../templates/ppt/js/pptPdfModeRenderer';

describe('Issue #79: i18n keys for fallback error dispatch', () => {
    const enMessages = JSON.parse(
        readFileSync(resolve(__dirname, '../../_locales/en/messages.json'), 'utf8')
    ) as Record<string, { message: string; description?: string }>;

    it('declares pptFallbackParserFailed', () => {
        expect(enMessages.pptFallbackParserFailed).toBeDefined();
        expect(enMessages.pptFallbackParserFailed.message.length).toBeGreaterThan(0);
    });

    it('declares pptFallbackNoRenderable', () => {
        expect(enMessages.pptFallbackNoRenderable).toBeDefined();
        expect(enMessages.pptFallbackNoRenderable.message.length).toBeGreaterThan(0);
    });

    it('declares pptFallbackBrowserFailed', () => {
        expect(enMessages.pptFallbackBrowserFailed).toBeDefined();
        expect(enMessages.pptFallbackBrowserFailed.message.length).toBeGreaterThan(0);
    });

    it('every fallback message is user-meaningful (no stack-trace markers)', () => {
        for (const key of [
            'pptFallbackParserFailed',
            'pptFallbackNoRenderable',
            'pptFallbackBrowserFailed'
        ]) {
            const msg = enMessages[key].message;
            // Stack traces include `at `, `Error: `, or path separators
            // followed by `.ts` / `.js`. We look for any of those and
            // fail loudly if a developer ever pastes one into the bundle.
            expect(msg).not.toMatch(/\bat\s+\w/);
            expect(msg).not.toMatch(/Error: /);
            expect(msg).not.toMatch(/\.(?:ts|js):\d+/);
        }
    });
});

describe('Issue #79: error-kind selection from helper return values', () => {
    // The production dispatch site picks one of three i18n keys:
    //   - parserFailure → primary parser threw
    //   - noRenderable  → parser succeeded but countPptxRenderableShapes()
    //                     returned 0 AND extractPptxFallbackText() came
    //                     back empty
    //   - browserFailure → JSZip / pdf.js bootstrap threw
    //
    // The unit-level assertion here is: the helpers report the conditions
    // that the dispatch needs in order to pick the right key. We don't
    // re-test the helpers themselves (those are in their own suites);
    // we just confirm the signatures the dispatch reads from.

    it('simulated parser-failure path: countPptxRenderableShapes on undefined doc is 0', () => {
        // The dispatch never reaches this branch on a parser-failure;
        // it shows pptFallbackParserFailed. We document that the gate is
        // safe to evaluate on a missing doc — defensive.
        expect(countPptxRenderableShapes(undefined as unknown as never)).toBe(0);
    });

    it('simulated no-renderable path: zero shapes + empty fallback → noRenderable', async () => {
        const emptyDoc = {
            slides: [],
            totalSlides: 0,
            zip: { file: () => null, files: {} } as never
        };
        const renderableCount = countPptxRenderableShapes(emptyDoc as never);
        const fallbackText = await extractPptxFallbackText(emptyDoc.zip as never);
        // Both conditions hold → dispatch would select pptFallbackNoRenderable.
        expect(renderableCount).toBe(0);
        expect(fallbackText).toEqual([]);
    });

    it('simulated browser-failure path: loose-text fallback returns [] for garbage', () => {
        // When JSZip throws (PPTX) or the buffer is not a CFB (PPT), the
        // dispatch surfaces pptFallbackBrowserFailed. We assert that the
        // loose-text helper does not throw on garbage — that lets the
        // dispatch decide which key to surface without an unhandled
        // exception.
        const garbage = new Uint8Array(8);
        expect(() => extractLooseTextFromCfb(garbage)).not.toThrow();
        expect(extractLooseTextFromCfb(garbage)).toEqual([]);
    });
});

describe('Issue #79: pdf.js mode hook smoke test', () => {
    it('renderPdfSlides is exported as a function', () => {
        expect(typeof renderPdfSlides).toBe('function');
    });

    it('returns an empty-page handle when pdfBytes is empty (no network)', async () => {
        // Empty bytes short-circuits inside `renderPdfSlides` before any
        // pdf.js loader is invoked, so this test is safe under jsdom.
        const container = document.createElement('div');
        const handle = await renderPdfSlides(new Uint8Array(0), container);
        expect(handle.numPages).toBe(0);
        expect(typeof handle.revoke).toBe('function');
        // revoke() must be callable without throwing.
        expect(() => handle.revoke()).not.toThrow();
    });

    it('rejects when no container is supplied (defensive)', async () => {
        await expect(
            renderPdfSlides(new Uint8Array(0), null as unknown as HTMLElement)
        ).rejects.toThrow();
    });
});
