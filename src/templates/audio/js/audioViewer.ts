// Audio viewer entry — Chrome adapter over omni-viewer-core.
//
// Chrome contributes only the platform bindings the core cannot have:
//
//   - the vendored WaveSurfer ESM modules (`vendor/wavesurfer/**`). MV3's CSP
//     allows dynamic `import()` of same-origin URLs only, so they are loaded
//     through `chrome.runtime.getURL` rather than bundled by webpack (the
//     plugins resolve their own siblings relative to the importing module).
//   - the WASM decode/analysis engine, copied out of the core package into
//     `dist/assets/audio-engine/` by webpack and served as a web-accessible
//     resource. It runs in a Worker (see `createWorkerAudioEngine`).
//   - i18n, logging and File -> ViewerInput conversion.
//
// Waveform/spectrogram rendering, regions, zoom, the info panel and the
// large-file precomputed-peaks path all live in the core viewer.

import {
    createWorkerAudioEngine,
    mountAudioViewer as mountCoreAudioViewer,
    type AudioPluginHandle,
    type AudioRegionsHandle,
    type AudioViewerContext,
    type AudioViewerDeps,
    type AudioWaveformLibrary,
    type AudioWaveSurferHandle
} from 'omni-viewer-core/viewers/audio';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type AudioViewerHandle = ViewerHandle;

/** Extension-relative path -> loadable URL. Falls back to the raw path in
 *  tests/non-extension hosts so imports don't crash at module scope. */
function extensionUrl(path: string): string {
    return typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL(path)
        : path;
}

function context(): AudioViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n : undefined;
    return {
        // The core addresses engine assets as `audio-engine/*` while pdf.js
        // uses a full `assets/...` key; normalize both onto dist/assets/.
        assets: { resolveAssetUrl: async (path) =>
            extensionUrl(path.startsWith('assets/') ? path : `assets/${path}`) },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer audio]', message) }
    };
}

// --- Vendored WaveSurfer -------------------------------------------------

interface WaveSurferFactory { create(options: Record<string, unknown>): AudioWaveSurferHandle }
interface PluginFactory<T> { create(options?: Record<string, unknown>): T }
type VendorModule<T> = { default: T };

async function importVendor<T>(path: string): Promise<T> {
    return (await import(/* webpackIgnore: true */ extensionUrl(path))) as T;
}

let waveformLibrary: Promise<AudioWaveformLibrary> | undefined;

/** Cached across mounts: the vendored modules are stateless factories. */
function loadWaveform(): Promise<AudioWaveformLibrary> {
    return (waveformLibrary ??= buildWaveformLibrary());
}

async function buildWaveformLibrary(): Promise<AudioWaveformLibrary> {
    const WaveSurfer = (
        await importVendor<VendorModule<WaveSurferFactory>>('vendor/wavesurfer/wavesurfer.esm.js')
    ).default;

    // Plugins are optional: the core degrades to a plain waveform when a
    // factory is missing, which beats failing the whole mount.
    const [regions, timeline, spectrogram] = await Promise.allSettled([
        importVendor<VendorModule<PluginFactory<AudioRegionsHandle>>>('vendor/wavesurfer/plugins/regions.js'),
        importVendor<VendorModule<PluginFactory<AudioPluginHandle>>>('vendor/wavesurfer/plugins/timeline.js'),
        importVendor<VendorModule<PluginFactory<AudioPluginHandle>>>('vendor/wavesurfer/plugins/spectrogram.js')
    ]);

    const library: AudioWaveformLibrary = {
        createWaveSurfer: (options) =>
            WaveSurfer.create(options as unknown as Record<string, unknown>)
    };
    if (regions.status === 'fulfilled') {
        library.createRegions = () => regions.value.default.create();
    }
    if (timeline.status === 'fulfilled') {
        library.createTimeline = (options) => timeline.value.default.create(options as unknown as Record<string, unknown>);
    }
    if (spectrogram.status === 'fulfilled') {
        library.createSpectrogram = (options) => spectrogram.value.default.create(options as unknown as Record<string, unknown>);
    }
    return library;
}

// --- Mount ---------------------------------------------------------------

export async function mountAudioViewer(file: File, container: HTMLElement): Promise<AudioViewerHandle> {
    const ctx = context();
    // Worker-backed so a WASM decode that stalls (or never returns) cannot
    // freeze the extension page — the core terminates the worker on timeout.
    const engine = typeof Worker !== 'undefined' ? createWorkerAudioEngine(ctx) : undefined;
    const deps: AudioViewerDeps = { loadWaveform, ...(engine ? { engine } : {}) };

    const handle = await mountCoreAudioViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        ctx,
        { deps }
    );
    return {
        dispose(): void {
            handle.dispose();
            engine?.dispose();
        }
    };
}

function createAudioProvider(): ChromeViewerProvider {
    let handle: AudioViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountAudioViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

const registration = VIEWER_REGISTRATIONS.find((r) => r.viewType === 'omni-viewer.audioViewer');
if (registration) registration.createProvider = createAudioProvider;

declare global { interface Window { __omniMountAudio?: typeof mountAudioViewer; } }
if (typeof window !== 'undefined') window.__omniMountAudio = mountAudioViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="audio"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'audio');
        await mountAudioViewer(new File([blob], name, { type: blob.type }), host);
    } catch (error) {
        host.textContent = `Failed to load audio: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="audio"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
