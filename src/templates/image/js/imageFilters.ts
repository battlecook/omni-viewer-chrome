// Pure helpers for the image-viewer filter sliders + presets (issue #10).
// Mirrors `vscode-omni-viewer/src/templates/image/js/imageFilters.js`,
// keeping the same preset numeric values and the same CSS filter string
// shape (`brightness(N%) contrast(N%) saturate(N%) grayscale(N%)`).

export interface FilterValues {
    brightness: number;
    contrast: number;
    saturation: number;
    grayscale: number;
}

export type FilterPresetName = 'normal' | 'bright' | 'dark' | 'vintage' | 'bw';

export const IDENTITY_FILTER_VALUES: FilterValues = Object.freeze({
    brightness: 100,
    contrast: 100,
    saturation: 100,
    grayscale: 0
}) as FilterValues;

export const FILTER_PRESETS: Readonly<Record<FilterPresetName, FilterValues>> = Object.freeze({
    normal: { brightness: 100, contrast: 100, saturation: 100, grayscale: 0 },
    bright: { brightness: 130, contrast: 110, saturation: 100, grayscale: 0 },
    dark: { brightness: 70, contrast: 120, saturation: 100, grayscale: 0 },
    vintage: { brightness: 110, contrast: 90, saturation: 70, grayscale: 10 },
    bw: { brightness: 100, contrast: 120, saturation: 0, grayscale: 100 }
}) as Readonly<Record<FilterPresetName, FilterValues>>;

export const FILTER_BOUNDS = Object.freeze({
    brightness: { min: 0, max: 200 },
    contrast: { min: 0, max: 200 },
    saturation: { min: 0, max: 200 },
    grayscale: { min: 0, max: 100 }
}) as const;

export function clampFilterValue(channel: keyof FilterValues, raw: number): number {
    const bounds = FILTER_BOUNDS[channel];
    if (!Number.isFinite(raw)) return bounds.min;
    if (raw < bounds.min) return bounds.min;
    if (raw > bounds.max) return bounds.max;
    return Math.round(raw);
}

export function buildFilterString(values: FilterValues): string {
    const b = clampFilterValue('brightness', values.brightness);
    const c = clampFilterValue('contrast', values.contrast);
    const s = clampFilterValue('saturation', values.saturation);
    const g = clampFilterValue('grayscale', values.grayscale);
    return `brightness(${b}%) contrast(${c}%) saturate(${s}%) grayscale(${g}%)`;
}

export function applyPreset(name: FilterPresetName): FilterValues {
    const preset = FILTER_PRESETS[name];
    return { ...preset };
}

export function filterValuesEqual(a: FilterValues, b: FilterValues): boolean {
    return a.brightness === b.brightness
        && a.contrast === b.contrast
        && a.saturation === b.saturation
        && a.grayscale === b.grayscale;
}

export function detectMatchingPreset(values: FilterValues): FilterPresetName | null {
    for (const name of Object.keys(FILTER_PRESETS) as FilterPresetName[]) {
        if (filterValuesEqual(values, FILTER_PRESETS[name])) return name;
    }
    return null;
}
