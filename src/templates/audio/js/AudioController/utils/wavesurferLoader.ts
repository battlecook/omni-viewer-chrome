// Dynamic loader for the bundled WaveSurfer ESM modules.
//
// The Chrome MV3 build cannot static-import WaveSurfer because the library
// lives under `vendor/wavesurfer/` and is only WAR-accessible at runtime
// via `chrome.runtime.getURL`. We therefore expose lazy loaders that
// resolve the public WaveSurfer factory + plugin classes the first time
// they're requested and cache the result.
//
// Vendor files (verified via `ls vendor/wavesurfer/`):
//   - wavesurfer.esm.js              -- standalone ESM bundle (bundle of
//                                       wavesurfer.js + base-plugin/dom).
//   - plugins/timeline.esm.js        -- standalone timeline plugin.
//   - plugins/zoom.esm.js            -- standalone zoom plugin (unused here
//                                       but kept for parity).
//   - plugins/regions.js             -- ESM source, references siblings.
//   - plugins/hover.js               -- ESM source.
//   - plugins/minimap.js             -- ESM source.
//   - plugins/spectrogram.js         -- ESM source.
//
// The non-`.esm.js` plugins import sibling files (`../base-plugin.js`,
// `../wavesurfer.js`, etc.) at runtime. Browser native ESM resolves those
// relative paths against the importing module's URL, so loading them via
// `chrome.runtime.getURL('vendor/wavesurfer/plugins/regions.js')` works
// without bundling.

// Loose typing for the WaveSurfer surface — we don't bundle the type
// declarations because the vendored ESM modules are intentionally
// untyped. The caller treats the returned values as opaque factories.
export type WaveSurferModule = {
    default: WaveSurferConstructor;
};

export type WaveSurferConstructor = {
    create: (options: Record<string, unknown>) => WaveSurferInstance;
} & (new (...args: unknown[]) => WaveSurferInstance);

export interface WaveSurferInstance {
    on(event: string, handler: (...args: unknown[]) => void): () => void;
    play: (start?: number, end?: number) => Promise<void> | void;
    pause: () => void;
    stop: () => void;
    setVolume: (volume: number) => void;
    setPlaybackRate: (rate: number, preservePitch?: boolean) => void;
    setOptions?: (opts: Record<string, unknown>) => void;
    getDuration: () => number;
    getCurrentTime: () => number;
    getDecodedData?: () => AudioBuffer | null;
    registerPlugin: <P>(plugin: P) => P;
    unregisterPlugin: (plugin: unknown) => void;
    zoom: (pxPerSec: number) => void;
    options: { minPxPerSec?: number };
    getWrapper?: () => HTMLElement;
    load: (url: string) => Promise<void>;
    destroy: () => void;
    backend?: { audioContext?: AudioContext };
}

export type WaveSurferPluginFactory = {
    default: { create: (options: Record<string, unknown>) => unknown };
};

interface CachedModules {
    WaveSurfer: WaveSurferConstructor | null;
    Hover: WaveSurferPluginFactory['default'] | null;
    Minimap: WaveSurferPluginFactory['default'] | null;
    Regions: WaveSurferPluginFactory['default'] | null;
    Spectrogram: WaveSurferPluginFactory['default'] | null;
    Timeline: WaveSurferPluginFactory['default'] | null;
}

const cache: CachedModules = {
    WaveSurfer: null,
    Hover: null,
    Minimap: null,
    Regions: null,
    Spectrogram: null,
    Timeline: null
};

function vendorUrl(path: string): string {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(path);
    }
    // Tests / non-extension hosts: fall back to a relative URL so jsdom
    // doesn't crash at import time. The dynamic import never actually
    // fires under jest because controller bootstrap is gated behind
    // `start()`.
    return path;
}

async function dynImport<T>(path: string): Promise<T> {
    // The vendored modules ship plain ESM. `import(...)` is allowed in
    // MV3 extension pages (script-src 'self' permits same-origin imports);
    // CSP blocks remote-origin imports, which is what we want.
    /* webpackIgnore: true */
    return (await import(/* webpackIgnore: true */ vendorUrl(path))) as T;
}

export async function loadWaveSurfer(): Promise<WaveSurferConstructor> {
    if (cache.WaveSurfer) return cache.WaveSurfer;
    const mod = await dynImport<WaveSurferModule>('vendor/wavesurfer/wavesurfer.esm.js');
    cache.WaveSurfer = mod.default;
    return mod.default;
}

export async function loadHoverPlugin() {
    if (cache.Hover) return cache.Hover;
    const mod = await dynImport<WaveSurferPluginFactory>(
        'vendor/wavesurfer/plugins/hover.js'
    );
    cache.Hover = mod.default;
    return mod.default;
}

export async function loadMinimapPlugin() {
    if (cache.Minimap) return cache.Minimap;
    const mod = await dynImport<WaveSurferPluginFactory>(
        'vendor/wavesurfer/plugins/minimap.js'
    );
    cache.Minimap = mod.default;
    return mod.default;
}

export async function loadRegionsPlugin() {
    if (cache.Regions) return cache.Regions;
    const mod = await dynImport<WaveSurferPluginFactory>(
        'vendor/wavesurfer/plugins/regions.js'
    );
    cache.Regions = mod.default;
    return mod.default;
}

export async function loadSpectrogramPlugin() {
    if (cache.Spectrogram) return cache.Spectrogram;
    const mod = await dynImport<WaveSurferPluginFactory>(
        'vendor/wavesurfer/plugins/spectrogram.js'
    );
    cache.Spectrogram = mod.default;
    return mod.default;
}

export async function loadTimelinePlugin() {
    if (cache.Timeline) return cache.Timeline;
    const mod = await dynImport<WaveSurferPluginFactory>(
        'vendor/wavesurfer/plugins/timeline.esm.js'
    );
    cache.Timeline = mod.default;
    return mod.default;
}
