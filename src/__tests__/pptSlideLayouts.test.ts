// Pure helper tests for the PPT slide layout module (issue #47).
//
// Everything in `src/utils/pptSlideLayouts.ts` is intentionally pure — no
// DOM, no zip, no async. These tests exercise:
//
//   - EMU → px conversion (with and without rounding),
//   - slide aspect ratio derivation + bucketing,
//   - theme font fallback for `+mj-lt` / `+mn-lt` and literal names,
//   - placeholder cascade (slide → layout → master) with idx / title /
//     custom-key matching.

import {
    EMU_PER_PX,
    DEFAULT_FALLBACK_FONT_STACK,
    DEFAULT_MAJOR_FONT_STACK,
    DEFAULT_MINOR_FONT_STACK,
    emuToPx,
    inferSlideAspectKind,
    resolvePlaceholderProps,
    resolveThemeFontFamily,
    slideAspectRatio,
    type PlaceholderProps
} from '../utils/pptSlideLayouts';

describe('emuToPx', () => {
    it('uses the canonical 1 px = 9525 EMU ratio', () => {
        expect(EMU_PER_PX).toBe(9525);
        expect(emuToPx(9525)).toBe(1);
        expect(emuToPx(9525 * 100)).toBe(100);
    });

    it('does not round by default (preserves precision for downstream math)', () => {
        const px = emuToPx(914400); // 1 inch = 914400 EMU = 96 px exactly
        expect(px).toBe(96);
        const fractional = emuToPx(9525 + 9525 / 2);
        expect(fractional).toBeCloseTo(1.5, 5);
    });

    it('rounds to nearest integer when requested (matches parser convention)', () => {
        expect(emuToPx(9525 + 9525 / 2, { round: true })).toBe(2);
        expect(emuToPx(9525 + 9525 / 4, { round: true })).toBe(1);
        expect(emuToPx(0, { round: true })).toBe(0);
    });

    it('returns 0 for non-finite input', () => {
        expect(emuToPx(Number.NaN)).toBe(0);
        expect(emuToPx(Number.POSITIVE_INFINITY)).toBe(0);
    });
});

describe('slideAspectRatio / inferSlideAspectKind', () => {
    it('returns the parsed width / height ratio', () => {
        expect(slideAspectRatio({ widthPx: 1280, heightPx: 720 })).toBeCloseTo(16 / 9, 5);
        expect(slideAspectRatio({ widthPx: 1024, heightPx: 768 })).toBeCloseTo(4 / 3, 5);
    });

    it('falls back to 16:9 for non-positive dimensions', () => {
        expect(slideAspectRatio({ widthPx: 0, heightPx: 720 })).toBeCloseTo(16 / 9, 5);
        expect(slideAspectRatio({ widthPx: 1280, heightPx: -1 })).toBeCloseTo(16 / 9, 5);
        expect(slideAspectRatio({ widthPx: Number.NaN, heightPx: 720 })).toBeCloseTo(16 / 9, 5);
    });

    it('buckets common PowerPoint sizes', () => {
        expect(inferSlideAspectKind({ widthPx: 1280, heightPx: 720 })).toBe('16:9');
        expect(inferSlideAspectKind({ widthPx: 960, heightPx: 720 })).toBe('4:3');
        expect(inferSlideAspectKind({ widthPx: 1280, heightPx: 800 })).toBe('16:10');
    });

    it('returns custom for unusual ratios (e.g. portrait / banner)', () => {
        expect(inferSlideAspectKind({ widthPx: 720, heightPx: 1280 })).toBe('custom');
        expect(inferSlideAspectKind({ widthPx: 2000, heightPx: 500 })).toBe('custom');
    });

    it('tolerates small rounding error from the EMU conversion', () => {
        // 9144000 × 6858000 EMU is the canonical 16:9 widescreen size; once
        // run through Math.round it lands at 960 × 720 which is exactly 4:3,
        // so the bucket honestly reports 4:3 — but a slightly different
        // widescreen 1280 × 720 must still register as 16:9 even with a
        // 1-pixel rounding wobble.
        expect(inferSlideAspectKind({ widthPx: 1281, heightPx: 720 })).toBe('16:9');
        expect(inferSlideAspectKind({ widthPx: 1279, heightPx: 720 })).toBe('16:9');
    });
});

describe('resolveThemeFontFamily', () => {
    it('returns the minor stack for body text by default', () => {
        expect(resolveThemeFontFamily(undefined)).toBe(DEFAULT_MINOR_FONT_STACK);
        expect(resolveThemeFontFamily('')).toBe(DEFAULT_MINOR_FONT_STACK);
        expect(resolveThemeFontFamily('   ')).toBe(DEFAULT_MINOR_FONT_STACK);
    });

    it('returns the major stack for titles', () => {
        expect(resolveThemeFontFamily(undefined, { isTitle: true })).toBe(DEFAULT_MAJOR_FONT_STACK);
        expect(resolveThemeFontFamily('', { isTitle: true })).toBe(DEFAULT_MAJOR_FONT_STACK);
    });

    it('maps the +mj-lt / +mn-lt theme tokens', () => {
        expect(resolveThemeFontFamily('+mj-lt')).toBe(DEFAULT_MAJOR_FONT_STACK);
        expect(resolveThemeFontFamily('+mn-lt')).toBe(DEFAULT_MINOR_FONT_STACK);
        // East-asian / complex script variants resolve to the same major /
        // minor families — we don't have a dedicated stack for them yet.
        expect(resolveThemeFontFamily('+mj-ea')).toBe(DEFAULT_MAJOR_FONT_STACK);
        expect(resolveThemeFontFamily('+mn-cs')).toBe(DEFAULT_MINOR_FONT_STACK);
    });

    it('honours an explicit theme override for the major / minor families', () => {
        const theme = { majorLatin: 'Helvetica Neue', minorLatin: 'Inter' };
        expect(resolveThemeFontFamily('+mj-lt', { theme }))
            .toBe(`"Helvetica Neue", ${DEFAULT_MAJOR_FONT_STACK}`);
        expect(resolveThemeFontFamily('+mn-lt', { theme }))
            .toBe(`Inter, ${DEFAULT_MINOR_FONT_STACK}`);
    });

    it('wraps a literal font name in a stack that ends in system-ui', () => {
        expect(resolveThemeFontFamily('Arial')).toBe(`Arial, ${DEFAULT_FALLBACK_FONT_STACK}`);
        expect(resolveThemeFontFamily('Times New Roman'))
            .toBe(`"Times New Roman", ${DEFAULT_FALLBACK_FONT_STACK}`);
    });

    it('preserves font names that already include quotes', () => {
        expect(resolveThemeFontFamily('"Custom Font"'))
            .toBe(`"Custom Font", ${DEFAULT_FALLBACK_FONT_STACK}`);
    });
});

describe('resolvePlaceholderProps', () => {
    const masterTitle: PlaceholderProps = {
        placeholderKey: 'type:title',
        isTitle: true,
        x: 50,
        y: 50,
        width: 1180,
        height: 100,
        fillColor: '#000000'
    };
    const layoutTitle: PlaceholderProps = {
        placeholderKey: 'type:title',
        isTitle: true,
        x: 60,
        y: 60,
        width: 1160,
        height: 110
    };
    const slideTitle: PlaceholderProps = {
        placeholderKey: 'type:title',
        isTitle: true,
        paragraphs: [{ text: 'Slide override' }]
    };

    it('inherits geometry from layout when slide has no geometry', () => {
        const out = resolvePlaceholderProps(slideTitle, layoutTitle, masterTitle, { isTitle: true });
        expect(out.width).toBe(1160);
        expect(out.height).toBe(110);
        expect(out.x).toBe(60);
        expect(out.y).toBe(60);
        expect(out.paragraphs).toEqual([{ text: 'Slide override' }]);
        expect(out.fillColor).toBe('#000000');
    });

    it('uses slide-level geometry when present', () => {
        const slideOverride: PlaceholderProps = {
            ...slideTitle,
            x: 100,
            y: 100,
            width: 1000,
            height: 80
        };
        const out = resolvePlaceholderProps(slideOverride, layoutTitle, masterTitle, { isTitle: true });
        expect(out.x).toBe(100);
        expect(out.width).toBe(1000);
    });

    it('falls back to master geometry when neither slide nor layout has it', () => {
        const layoutNoGeom: PlaceholderProps = { placeholderKey: 'type:title', isTitle: true };
        const out = resolvePlaceholderProps(slideTitle, layoutNoGeom, masterTitle, { isTitle: true });
        expect(out.x).toBe(50);
        expect(out.width).toBe(1180);
    });

    it('matches body placeholders by idx', () => {
        const masterBody: PlaceholderProps = {
            placeholderKey: 'idx:1',
            x: 50,
            y: 200,
            width: 1180,
            height: 500,
            paragraphs: [{ text: 'master prompt' }]
        };
        const slideBody: PlaceholderProps = {
            placeholderKey: 'idx:1',
            paragraphs: [{ text: 'real body content' }]
        };
        const out = resolvePlaceholderProps(slideBody, undefined, masterBody, { idx: 1 });
        expect(out.width).toBe(1180);
        expect(out.height).toBe(500);
        expect(out.paragraphs).toEqual([{ text: 'real body content' }]);
    });

    it('returns paragraphs only from layers that supply them (skips empty)', () => {
        const slide: PlaceholderProps = { placeholderKey: 'idx:1' };
        const layout: PlaceholderProps = { placeholderKey: 'idx:1', paragraphs: [] };
        const master: PlaceholderProps = {
            placeholderKey: 'idx:1',
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            paragraphs: [{ text: 'master fallback' }]
        };
        const out = resolvePlaceholderProps(slide, layout, master, { idx: 1 });
        expect(out.paragraphs).toEqual([{ text: 'master fallback' }]);
    });

    it('ignores layers that do not match the requested key', () => {
        const wrongKey: PlaceholderProps = { placeholderKey: 'type:body', x: 9999 };
        const right: PlaceholderProps = { placeholderKey: 'idx:2', x: 10, y: 20, width: 30, height: 40 };
        const out = resolvePlaceholderProps(undefined, wrongKey, right, { idx: 2 });
        expect(out.x).toBe(10);
    });

    it('returns empty when no layer matches', () => {
        const out = resolvePlaceholderProps(undefined, undefined, undefined, { idx: 7 });
        expect(out).toEqual({});
    });

    it('honours custom keys (e.g. type:body) in the matcher', () => {
        const layout: PlaceholderProps = {
            placeholderKey: 'type:body',
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            paragraphs: [{ text: 'body' }]
        };
        const out = resolvePlaceholderProps(undefined, layout, undefined, { key: 'type:body' });
        expect(out.width).toBe(30);
        expect(out.paragraphs).toEqual([{ text: 'body' }]);
    });

    it('treats non-positive geometry as missing (does not overwrite a deeper layer)', () => {
        const slide: PlaceholderProps = {
            placeholderKey: 'type:title',
            isTitle: true,
            x: 0,
            y: 0,
            width: 0,
            height: 0
        };
        const out = resolvePlaceholderProps(slide, layoutTitle, masterTitle, { isTitle: true });
        // Slide width is 0, so layout's 1160 should win.
        expect(out.width).toBe(1160);
    });
});
