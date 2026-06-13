// DOM helpers for the audio viewer. Strict-typed port of
// vscode-omni-viewer's AudioController/utils/DOMUtils.js.
//
// Differences from the VSCode original:
//   - Lookups happen against a *root* (the viewer container injected by the
//     router) instead of the global `document`. This keeps the viewer
//     embeddable inside `viewer.html`'s SPA without colliding with other
//     `id="..."` markup elsewhere on the page.
//   - The metadata script tag uses a JSON `application/json` payload, but
//     the Chrome viewer constructs metadata on the fly from the File handle,
//     so `getMetadata` first checks the dataset on the root container, then
//     falls back to the legacy `<script id="metadata-script">` shape.
//   - WASM precomputed mode is preserved as a hook (`getPrecomputedData`)
//     but the Chrome side currently has no precomputed transport, so the
//     helper returns `null`. See `WaveSurferManager.createPrecomputed` for
//     the consumer side.

export interface AudioMetadata {
    /** Original file name (with extension). */
    fileName?: string;
    /** Container/codec format label (e.g. "MP3", "WAV"). */
    format?: string;
    /** Duration in seconds. May be unreliable for OGG/streaming. */
    duration?: number;
    /** Decoded sample rate in Hz. */
    sampleRate?: number;
    /** Channel count (1 = mono, 2 = stereo). */
    channels?: number;
    /** Bit depth as reported by the source. */
    bitDepth?: number;
    /** Pretty-printed file size (e.g. "1.2 MB"). */
    fileSize?: string;
}

export interface PrecomputedDataPayload {
    /**
     * 'precomputed' = WASM produced peaks + spectrogram, MediaElement playback.
     * 'streaming'   = WASM unavailable / failed, MediaElement playback only.
     */
    mode: 'precomputed' | 'streaming';
    peaks?: number[][] | null;
    duration?: number | null;
    spectrogram?: number[][] | null;
    sampleRate?: number | null;
}

export interface AudioElements {
    playPause: HTMLButtonElement | null;
    stop: HTMLButtonElement | null;
    volume: HTMLInputElement | null;
    loopEnabled: HTMLInputElement | null;
    loopControls: HTMLElement | null;
    visualizationMode: HTMLElement | null;
    visualizationModeButtons: NodeListOf<HTMLElement> | HTMLElement[];
    spectrogramScaleGroup: HTMLElement | null;
    spectrogramScale: HTMLSelectElement | null;
    playbackSpeed: HTMLSelectElement | null;
    loading: HTMLElement | null;
    error: HTMLElement | null;
    waveform: HTMLElement | null;
    spectrogram: HTMLElement | null;
    minimap: HTMLElement | null;
    timeline: HTMLElement | null;
    status: HTMLElement | null;
    fileInfo: HTMLElement | null;
    durationInfo: HTMLElement | null;
    sampleRateInfo: HTMLElement | null;
    channelsInfo: HTMLElement | null;
    channelDetailsInfo: HTMLElement | null;
    bitDepthInfo: HTMLElement | null;
    fileSizeInfo: HTMLElement | null;
    formatInfo: HTMLElement | null;
    downloadBtn: HTMLButtonElement | null;
    zoomControls: HTMLElement | null;
    zoomIn: HTMLButtonElement | null;
    zoomOut: HTMLButtonElement | null;
    zoomLevel: HTMLElement | null;
    contextMenu: HTMLElement | null;
}

function $byClass<T extends HTMLElement = HTMLElement>(
    root: ParentNode,
    cls: string
): T | null {
    return root.querySelector<T>(`.${cls}`);
}

function $allByAttr(root: ParentNode, selector: string): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

/**
 * Build an `AudioElements` snapshot scoped to `root`. Each property is the
 * actual DOM node (or `null` if it isn't present yet).
 *
 * Elements are matched by class name (not id) so multiple audio viewers
 * could in theory coexist on the same page. Class names mirror the ids
 * used by the VSCode template for diff-friendliness — see
 * `audioViewer.html` in this repo.
 */
export function getElements(root: ParentNode): AudioElements {
    return {
        playPause: $byClass<HTMLButtonElement>(root, 'js-play-pause'),
        stop: $byClass<HTMLButtonElement>(root, 'js-stop'),
        volume: $byClass<HTMLInputElement>(root, 'js-volume'),
        loopEnabled: $byClass<HTMLInputElement>(root, 'js-loop-enabled'),
        loopControls: $byClass(root, 'js-loop-controls'),
        visualizationMode: $byClass(root, 'js-visualization-mode'),
        visualizationModeButtons: $allByAttr(root, '[data-view-mode]'),
        spectrogramScaleGroup: $byClass(root, 'js-spectrogram-scale-group'),
        spectrogramScale: $byClass<HTMLSelectElement>(root, 'js-spectrogram-scale'),
        playbackSpeed: $byClass<HTMLSelectElement>(root, 'js-playback-speed'),
        loading: $byClass(root, 'js-loading'),
        error: $byClass(root, 'js-error'),
        waveform: $byClass(root, 'js-waveform'),
        spectrogram: $byClass(root, 'js-spectrogram'),
        minimap: $byClass(root, 'js-minimap'),
        timeline: $byClass(root, 'js-timeline'),
        status: $byClass(root, 'js-status'),
        fileInfo: $byClass(root, 'js-file-info'),
        durationInfo: $byClass(root, 'js-duration-info'),
        sampleRateInfo: $byClass(root, 'js-sample-rate-info'),
        channelsInfo: $byClass(root, 'js-channels-info'),
        channelDetailsInfo: $byClass(root, 'js-channel-details-info'),
        bitDepthInfo: $byClass(root, 'js-bit-depth-info'),
        fileSizeInfo: $byClass(root, 'js-file-size-info'),
        formatInfo: $byClass(root, 'js-format-info'),
        downloadBtn: $byClass<HTMLButtonElement>(root, 'js-download-btn'),
        zoomControls: $byClass(root, 'js-zoom-controls'),
        zoomIn: $byClass<HTMLButtonElement>(root, 'js-zoom-in'),
        zoomOut: $byClass<HTMLButtonElement>(root, 'js-zoom-out'),
        zoomLevel: $byClass(root, 'js-zoom-level'),
        contextMenu: $byClass(root, 'js-context-menu')
    };
}

/**
 * Read metadata embedded in the host. The Chrome side seeds a small JSON
 * blob via `dataset.audioMetadata`; the legacy `<script id="metadata-script">`
 * shape is kept as a fallback so the same controller can run from the VSCode
 * template if needed.
 */
export function getMetadata(root: HTMLElement): AudioMetadata {
    try {
        const datasetMeta = root.dataset.audioMetadata;
        if (datasetMeta) {
            return JSON.parse(datasetMeta) as AudioMetadata;
        }
        const scriptEl = root.querySelector<HTMLScriptElement>('#metadata-script');
        if (scriptEl?.textContent) {
            return JSON.parse(scriptEl.textContent) as AudioMetadata;
        }
    } catch (error) {
        console.warn('Error parsing audio metadata:', error);
    }
    return {};
}

/**
 * Read the WASM-precomputed peaks/spectrogram payload. The VSCode original
 * read this from a `<script id="precomputed-data">` element that the
 * extension host populated server-side.
 *
 * **Chrome status (TODO):** the extension does not currently produce
 * precomputed data — large-file precomputation via `vendor/audio_engine`
 * is out of scope for this issue. The hook is preserved so a follow-up
 * issue can wire in the WASM analyzer without touching the controller.
 */
export function getPrecomputedData(root: HTMLElement): PrecomputedDataPayload | null {
    try {
        const scriptEl = root.querySelector<HTMLScriptElement>('#precomputed-data');
        if (!scriptEl?.textContent) return null;
        const raw = JSON.parse(scriptEl.textContent);
        if (raw?.mode === 'precomputed') {
            return {
                mode: 'precomputed',
                peaks: raw.peaks ? JSON.parse(raw.peaks) : null,
                duration: raw.duration ? parseFloat(raw.duration) : null,
                spectrogram: raw.spectrogram ? JSON.parse(raw.spectrogram) : null,
                sampleRate: raw.sampleRate ? parseInt(raw.sampleRate, 10) : null
            };
        }
        if (raw?.mode === 'streaming') {
            return { mode: 'streaming' };
        }
    } catch (error) {
        console.warn('Error parsing precomputed data:', error);
    }
    return null;
}

export const DOMUtils = {
    getElements,
    getMetadata,
    getPrecomputedData
};
