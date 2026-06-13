import {
    FILTER_PRESETS,
    IDENTITY_FILTER_VALUES,
    applyPreset,
    buildFilterString,
    clampFilterValue,
    detectMatchingPreset,
    filterValuesEqual
} from '../templates/image/js/imageFilters';

describe('buildFilterString', () => {
    it('produces the expected CSS filter string for identity values', () => {
        expect(buildFilterString(IDENTITY_FILTER_VALUES)).toBe(
            'brightness(100%) contrast(100%) saturate(100%) grayscale(0%)'
        );
    });

    it('uses CSS function name "saturate" (not "saturation")', () => {
        const s = buildFilterString(IDENTITY_FILTER_VALUES);
        expect(s).toContain('saturate(');
        expect(s).not.toContain('saturation(');
    });

    it('clamps values to channel bounds', () => {
        const s = buildFilterString({ brightness: 999, contrast: -50, saturation: 220, grayscale: -10 });
        expect(s).toBe('brightness(200%) contrast(0%) saturate(200%) grayscale(0%)');
    });

    it('rounds non-integer slider values', () => {
        const s = buildFilterString({ brightness: 100.6, contrast: 100.4, saturation: 100, grayscale: 50.5 });
        expect(s).toBe('brightness(101%) contrast(100%) saturate(100%) grayscale(51%)');
    });

    it('handles 0 / max boundaries', () => {
        expect(buildFilterString({ brightness: 0, contrast: 0, saturation: 0, grayscale: 0 }))
            .toBe('brightness(0%) contrast(0%) saturate(0%) grayscale(0%)');
        expect(buildFilterString({ brightness: 200, contrast: 200, saturation: 200, grayscale: 100 }))
            .toBe('brightness(200%) contrast(200%) saturate(200%) grayscale(100%)');
    });
});

describe('applyPreset', () => {
    it('returns an independent copy (mutating result does not change preset table)', () => {
        const v = applyPreset('vintage');
        v.brightness = 0;
        expect(FILTER_PRESETS.vintage.brightness).toBe(110);
    });

    it.each<[Parameters<typeof applyPreset>[0], number, number, number, number]>([
        ['normal', 100, 100, 100, 0],
        ['bright', 130, 110, 100, 0],
        ['dark', 70, 120, 100, 0],
        ['vintage', 110, 90, 70, 10],
        ['bw', 100, 120, 0, 100]
    ])('preset %s -> %i/%i/%i/%i', (name, b, c, s, g) => {
        const v = applyPreset(name);
        expect(v).toEqual({ brightness: b, contrast: c, saturation: s, grayscale: g });
    });
});

describe('clampFilterValue', () => {
    it('floors NaN to channel min', () => {
        expect(clampFilterValue('brightness', Number.NaN)).toBe(0);
    });
    it('respects per-channel bounds (grayscale max 100, others 200)', () => {
        expect(clampFilterValue('grayscale', 200)).toBe(100);
        expect(clampFilterValue('brightness', 200)).toBe(200);
    });
});

describe('filterValuesEqual + detectMatchingPreset', () => {
    it('detects identity == normal', () => {
        expect(detectMatchingPreset(IDENTITY_FILTER_VALUES)).toBe('normal');
    });
    it('detects bw preset', () => {
        expect(detectMatchingPreset(FILTER_PRESETS.bw)).toBe('bw');
    });
    it('returns null for off-preset slider state', () => {
        expect(detectMatchingPreset({ brightness: 105, contrast: 100, saturation: 100, grayscale: 0 }))
            .toBeNull();
    });
    it('filterValuesEqual is reflexive', () => {
        expect(filterValuesEqual(FILTER_PRESETS.vintage, FILTER_PRESETS.vintage)).toBe(true);
    });
});
