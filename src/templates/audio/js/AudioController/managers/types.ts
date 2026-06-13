// Shared types for the audio controller managers.
//
// The original VSCode controller used a single mutable `state` object that
// every manager shared. We keep that shape (it makes the diff trivial), but
// type each field so TypeScript can catch the misspellings the JS port had.

import type { AudioElements } from '../utils/DOMUtils';
import type { WaveSurferInstance } from '../utils/wavesurferLoader';

// Forward declarations: these classes import from this file so we declare
// minimal structural types here to avoid circular imports.
export interface RegionManagerLike {
    showControls(): void;
    hideControls(): void;
    clearAllRegions(): void;
    clearRegionsFromDOM(): void;
    getSelectedRegion(): RegionLike | null;
    createOverlays(region: RegionLike): void;
    updateSelectedRegionOverlays(): void;
}

export interface RegionLike {
    id: string;
    start: number;
    end: number;
    color?: string;
    element?: HTMLElement;
    on?: (event: string, handler: (...args: unknown[]) => void) => () => void;
    remove: () => void;
}

export interface RegionsPluginLike {
    enableDragSelection: (opts: { color?: string }) => void;
    on: (event: string, handler: (region: RegionLike) => void) => () => void;
    getRegions: () => Record<string, RegionLike>;
    addRegion: (opts: { start: number; end: number; color?: string }) => RegionLike;
}

export interface FileInfoManagerLike {
    updateDuration(durationFromMetadata?: number | null): void;
    updateFileInfo(): void;
}

export interface PluginManagerLike {
    setupSpectrogram(opts?: { splitChannels?: boolean }): Promise<void>;
    setupSpectrogramPrecomputed(spectrogramData: number[][], sampleRate: number): Promise<void>;
    setupTimeline(): Promise<void>;
    setupRegions(): Promise<void>;
    changeSpectrogramScale(scale: string): Promise<void>;
}

export interface AudioControllerLike {
    setVisualizationMode(mode: string): void;
    showLoadError(message: string): void;
    extractAndDownloadRegion?(region: RegionLike): Promise<void> | void;
}

export type VisualizationMode = 'waveform' | 'spectrogram' | 'both';

export interface AudioControllerState {
    /** WaveSurfer instance once it has been constructed. */
    wavesurfer: WaveSurferInstance | null;
    /** Spectrogram plugin (untyped — wavesurfer plugin objects are opaque). */
    spectrogramPlugin: SpectrogramPluginLike | null;
    timelinePlugin: unknown | null;
    regionsPlugin: RegionsPluginLike | null;
    spectrogramSplitChannels: boolean;
    visualizationMode: VisualizationMode;
    isPlaying: boolean;
    loopEnabled: boolean;
    isSetupComplete: boolean;
    audioContextInitialized: boolean;
    selectedRegionId: string | null;
    regionStartOverlay: HTMLDivElement | null;
    regionEndOverlay: HTMLDivElement | null;
    regionDurationOverlay: HTMLDivElement | null;
    loadTimeoutId: ReturnType<typeof setTimeout> | null;
    elements: AudioElements;

    /** Container the viewer was mounted into. Used to scope DOM operations. */
    root: HTMLElement;

    // Cross-references populated by the controller after construction so that
    // managers can call into each other without ad-hoc imports.
    audioContextManager?: unknown;
    regionManager: RegionManagerLike;
    fileInfoManager?: FileInfoManagerLike;
    pluginManager?: PluginManagerLike;
    audioController?: AudioControllerLike;

    // Precomputed-mode caches.
    precomputedSpectrogramData?: number[][] | null;
    precomputedSampleRate?: number | null;
}

export interface SpectrogramPluginLike {
    render: () => void | Promise<void>;
    drawSpectrogram?: (channelData: Uint8Array[][]) => void;
    isRendering?: boolean;
    isDestroyed?: boolean;
    frequencyMax?: number;
    cachedFrequencies?: Uint8Array[][];
    lastZoomLevel?: number;
    wrapper?: HTMLElement;
    wavesurfer?: { options?: { minPxPerSec?: number } };
    params?: { fftSize?: number };
}
