// PluginManager — owns timeline / regions / spectrogram registration.
//
// Port of vscode-omni-viewer's AudioController/managers/PluginManager.js.
// Plugin imports are dynamic (see ../utils/wavesurferLoader.ts) since the
// Chrome build cannot static-import from `vendor/`.

import { CONSTANTS } from '../utils/Constants';
import { AudioUtils } from '../utils/AudioUtils';
import {
    loadRegionsPlugin,
    loadSpectrogramPlugin,
    loadTimelinePlugin
} from '../utils/wavesurferLoader';
import type {
    AudioControllerState,
    RegionLike,
    SpectrogramPluginLike
} from './types';
import type { WaveSurferManager } from './WaveSurferManager';

export class PluginManager {
    private readonly state: AudioControllerState;
    private readonly waveSurferManager: WaveSurferManager;
    /** Cached so we can rebuild the spectrogram on scale change. */
    private currentSpectrogramScale: string = CONSTANTS.SPECTROGRAM.DEFAULT_SCALE;

    constructor(state: AudioControllerState, waveSurferManager: WaveSurferManager) {
        this.state = state;
        this.waveSurferManager = waveSurferManager;
    }

    private clearSpectrogramContainer(): void {
        const container = this.state.elements.spectrogram;
        if (container) container.innerHTML = '';
    }

    async setupSpectrogram({ splitChannels = false }: { splitChannels?: boolean } = {}): Promise<void> {
        this.state.spectrogramSplitChannels = splitChannels;

        if (this.state.spectrogramPlugin) {
            try {
                this.state.wavesurfer?.unregisterPlugin(this.state.spectrogramPlugin);
                this.state.spectrogramPlugin = null;
            } catch (error) {
                console.warn('Error removing existing spectrogram plugin:', error);
            }
        }

        this.clearSpectrogramContainer();

        try {
            const SpectrogramPlugin = await loadSpectrogramPlugin();
            const spectrogramEl = this.state.elements.spectrogram;
            if (!spectrogramEl || !this.state.wavesurfer) return;
            this.state.spectrogramPlugin = this.state.wavesurfer.registerPlugin(
                SpectrogramPlugin.create({
                    container: spectrogramEl,
                    labels: true,
                    scale: this.currentSpectrogramScale,
                    splitChannels,
                    fftSize: CONSTANTS.SPECTROGRAM.FFT_SIZE,
                    noverlap: CONSTANTS.SPECTROGRAM.NOVERLAP,
                    height: CONSTANTS.SPECTROGRAM.HEIGHT
                })
            ) as SpectrogramPluginLike;
            this.tagSpectrogramWrapper();
            AudioUtils.log('Spectrogram plugin registered successfully');
        } catch (error) {
            console.warn('Failed to register spectrogram plugin:', error);
            this.state.spectrogramPlugin = null;
        }
    }

    /**
     * Mark the spectrogram plugin's wrapper with a class so the view-mode
     * CSS rules in audioViewer.css can hide it without depending on the
     * plugin internals. The vendored plugin overrides `this.container` to
     * the wavesurfer wrapper on `onInit`, which means the spectrogram is a
     * child of `.js-waveform` rather than `.js-spectrogram` — without the
     * marker class there's no stable selector to target.
     */
    private tagSpectrogramWrapper(): void {
        const wrapper = this.state.spectrogramPlugin?.wrapper;
        if (wrapper) wrapper.classList.add('js-spectrogram-wrapper');
    }

    /**
     * Setup the spectrogram plugin with WASM-precomputed frequency data.
     *
     * **Chrome status (TODO):** unreachable from `index.ts` until the WASM
     * analyzer is wired up. Preserved verbatim for behavioral parity.
     */
    async setupSpectrogramPrecomputed(
        spectrogramData: number[][],
        sampleRate: number
    ): Promise<void> {
        if (!this.state.wavesurfer) return;
        if (this.state.spectrogramPlugin) {
            try {
                this.state.wavesurfer.unregisterPlugin(this.state.spectrogramPlugin);
                this.state.spectrogramPlugin = null;
            } catch (error) {
                console.warn('Error removing existing spectrogram plugin:', error);
            }
        }
        this.clearSpectrogramContainer();

        try {
            const SpectrogramPlugin = await loadSpectrogramPlugin();
            this.state.precomputedSpectrogramData = spectrogramData;
            this.state.precomputedSampleRate = sampleRate;

            const freqData: Uint8Array[] = spectrogramData.map(
                (slice) => new Uint8Array(slice)
            );
            const channelData: Uint8Array[][] = [freqData];

            const spectrogramEl = this.state.elements.spectrogram;
            if (!spectrogramEl) return;

            const plugin = this.state.wavesurfer.registerPlugin(
                SpectrogramPlugin.create({
                    container: spectrogramEl,
                    labels: true,
                    scale: this.currentSpectrogramScale,
                    splitChannels: false,
                    height: CONSTANTS.SPECTROGRAM.HEIGHT,
                    sampleRate
                })
            ) as SpectrogramPluginLike;
            this.state.spectrogramPlugin = plugin;
            this.tagSpectrogramWrapper();

            plugin.frequencyMax = sampleRate / 2;
            plugin.cachedFrequencies = channelData;

            // Override render() so wavesurfer's internal decode events don't
            // overwrite our precomputed FFT data.
            plugin.render = async function () {
                if (this.isRendering) return;
                this.isRendering = true;
                try {
                    this.drawSpectrogram?.(this.cachedFrequencies ?? []);
                    this.lastZoomLevel = this.wavesurfer?.options?.minPxPerSec || 0;
                } finally {
                    this.isRendering = false;
                }
            } as SpectrogramPluginLike['render'];

            setTimeout(() => {
                if (plugin && !plugin.isDestroyed) {
                    void plugin.render();
                    AudioUtils.log(
                        `Precomputed spectrogram drawn: ${freqData.length} time slices, sampleRate=${sampleRate}`
                    );
                }
            }, 200);
        } catch (error) {
            console.warn('Failed to setup precomputed spectrogram:', error);
        }
    }

    async changeSpectrogramScale(newScale: string): Promise<void> {
        if (!this.state.spectrogramPlugin || !this.state.wavesurfer) {
            console.warn('Spectrogram plugin not available');
            return;
        }
        this.currentSpectrogramScale = newScale;

        try {
            this.state.wavesurfer.unregisterPlugin(this.state.spectrogramPlugin);
            this.state.spectrogramPlugin = null;

            this.clearSpectrogramContainer();

            const SpectrogramPlugin = await loadSpectrogramPlugin();
            const spectrogramEl = this.state.elements.spectrogram;
            if (!spectrogramEl) return;

            const opts: Record<string, unknown> = {
                container: spectrogramEl,
                labels: true,
                scale: newScale,
                splitChannels: this.state.spectrogramSplitChannels || false,
                height: CONSTANTS.SPECTROGRAM.HEIGHT
            };

            if (this.state.precomputedSpectrogramData) {
                opts.sampleRate = this.state.precomputedSampleRate;
            } else {
                opts.fftSize = CONSTANTS.SPECTROGRAM.FFT_SIZE;
                opts.noverlap = CONSTANTS.SPECTROGRAM.NOVERLAP;
            }

            this.state.spectrogramPlugin = this.state.wavesurfer.registerPlugin(
                SpectrogramPlugin.create(opts)
            ) as SpectrogramPluginLike;
            this.tagSpectrogramWrapper();

            if (this.state.precomputedSpectrogramData) {
                const plugin = this.state.spectrogramPlugin;
                const freqData = this.state.precomputedSpectrogramData.map(
                    (slice) => new Uint8Array(slice)
                );
                plugin.frequencyMax = (this.state.precomputedSampleRate ?? 0) / 2;
                plugin.cachedFrequencies = [freqData];
                plugin.render = async function () {
                    if (this.isRendering) return;
                    this.isRendering = true;
                    try {
                        this.drawSpectrogram?.(this.cachedFrequencies ?? []);
                        this.lastZoomLevel = this.wavesurfer?.options?.minPxPerSec || 0;
                    } finally {
                        this.isRendering = false;
                    }
                } as SpectrogramPluginLike['render'];
                setTimeout(() => void plugin.render(), 200);
            } else {
                setTimeout(() => {
                    void this.state.spectrogramPlugin?.render();
                }, 100);
            }

            AudioUtils.log(`Spectrogram scale changed to: ${newScale}`);
        } catch (error) {
            console.warn('Failed to change spectrogram scale:', error);
        }
    }

    async setupTimeline(): Promise<void> {
        if (!this.state.wavesurfer) return;
        if (this.state.timelinePlugin) {
            try {
                this.state.wavesurfer.unregisterPlugin(this.state.timelinePlugin);
                this.state.timelinePlugin = null;
            } catch (error) {
                console.warn('Error removing existing timeline plugin:', error);
            }
        }

        const timelineContainer = this.state.elements.timeline;
        if (timelineContainer) timelineContainer.innerHTML = '';

        try {
            const TimelinePlugin = await loadTimelinePlugin();
            const intervals = this.waveSurferManager.getTimelineIntervals(
                this.state.wavesurfer.getDuration()
            );
            this.state.timelinePlugin = this.state.wavesurfer.registerPlugin(
                TimelinePlugin.create({
                    container: timelineContainer ?? undefined,
                    formatTimeCallback: AudioUtils.formatTime,
                    timeInterval: intervals.timeInterval,
                    primaryLabelInterval: intervals.primaryLabelInterval,
                    secondaryLabelInterval: intervals.secondaryLabelInterval
                })
            );
            AudioUtils.log('Timeline plugin registered successfully');
        } catch (error) {
            console.warn('Failed to register timeline plugin:', error);
            this.state.timelinePlugin = null;
        }
    }

    async setupRegions(): Promise<void> {
        if (!this.state.wavesurfer) return;
        try {
            const RegionsPlugin = await loadRegionsPlugin();
            this.state.regionsPlugin = this.state.wavesurfer.registerPlugin(
                RegionsPlugin.create({})
            ) as AudioControllerState['regionsPlugin'];
            AudioUtils.log('Regions plugin registered successfully');
        } catch (error) {
            console.warn('Failed to register regions plugin:', error);
            this.state.regionsPlugin = null;
            return;
        }

        this.setupRegionEvents();
    }

    private setupRegionEvents(): void {
        const regionsPlugin = this.state.regionsPlugin;
        if (!regionsPlugin) return;

        regionsPlugin.enableDragSelection({ color: 'rgba(255, 0, 0, 0.1)' });

        regionsPlugin.on('region-created', (region: RegionLike) => {
            // Only allow one region at a time.
            if (regionsPlugin.getRegions) {
                const newRegions = regionsPlugin.getRegions();
                Object.values(newRegions).forEach((existing) => {
                    if (existing.id !== region.id) {
                        existing.remove();
                    }
                });
            }
            this.state.selectedRegionId = region.id;
            this.state.regionManager.showControls();

            setTimeout(() => {
                this.state.regionManager.createOverlays(region);
            }, 100);
        });

        regionsPlugin.on('region-clicked', (region: RegionLike) => {
            this.state.selectedRegionId = region.id;
            this.state.regionManager.showControls();
            this.state.regionManager.createOverlays(region);
        });

        regionsPlugin.on('region-removed', (region: RegionLike) => {
            if (this.state.selectedRegionId === region.id) {
                this.state.selectedRegionId = null;
                this.state.regionManager.hideControls();
            }
        });

        regionsPlugin.on('region-updated', (region: RegionLike) => {
            if (this.state.selectedRegionId === region.id) {
                this.state.regionManager.updateSelectedRegionOverlays();
            }
        });

        regionsPlugin.on('region-update', (region: RegionLike) => {
            if (this.state.selectedRegionId === region.id) {
                this.state.regionManager.updateSelectedRegionOverlays();
            }
        });

        this.setupRegionClickHandlers();
    }

    /**
     * Wires click-clearing of regions on the waveform/spectrogram.
     *
     * Note: the right-click context menu used to live here, but issue #27
     * extracted that surface into `ContextMenuManager` so the menu can
     * carry the 7 region/A-B items. PluginManager now only owns the
     * "click outside region clears it" behaviour.
     */
    private setupRegionClickHandlers(): void {
        const removeAllRegions = () => {
            const regions = this.state.regionsPlugin?.getRegions?.();
            if (regions && Object.keys(regions).length > 0) {
                Object.values(regions).forEach((region) => region.remove());
                this.state.selectedRegionId = null;
                this.state.regionManager.hideControls();
            }
        };

        const waveformContainer = this.state.elements.waveform;
        if (!waveformContainer) return;

        waveformContainer.addEventListener('click', (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            const isRegionElement = !!(
                target?.closest('.wavesurfer-region') ||
                target?.closest('.region-input-overlay') ||
                target?.classList.contains('region-input-overlay') ||
                target?.classList.contains('region-start-input') ||
                target?.classList.contains('region-end-input') ||
                target?.classList.contains('region-duration-input')
            );
            if (!isRegionElement) {
                removeAllRegions();
            }
        });

        const spectrogramContainer = this.state.elements.spectrogram;
        if (spectrogramContainer) {
            spectrogramContainer.addEventListener('click', () => {
                removeAllRegions();
            });
        }
    }
}
