// AudioController orchestrator. Port of vscode-omni-viewer's
// AudioController/index.js, slimmed for the Chrome MV3 build:
//
//   - The File handle the router hands us is converted into a blob URL
//     once and treated as the canonical audio source.
//   - The VSCode "downloadFile" / postMessage paths are dropped — callers
//     can use the browser-native Save flow.
//   - WASM precomputed peaks (`audio_engine_browser`) is preserved as a
//     hook (`PrecomputedDataPayload`) but `getPrecomputedData` currently
//     returns null on the Chrome side. A follow-up issue will wire WASM
//     analysis in without changing this file.
//
// Usage:
//
//   const controller = new AudioController();
//   await controller.start(file, container);
//   // later, when the viewer is unmounted:
//   controller.dispose();

import { AudioContextManager } from './managers/AudioContextManager';
import { ContextMenuManager } from './managers/ContextMenuManager';
import { EventManager } from './managers/EventManager';
import { FileInfoManager } from './managers/FileInfoManager';
import { PluginManager } from './managers/PluginManager';
import { RegionManager } from './managers/RegionManager';
import { WaveSurferManager } from './managers/WaveSurferManager';
import {
    AudioMetadata,
    DOMUtils,
    PrecomputedDataPayload
} from './utils/DOMUtils';
import {
    AudioUtils,
    formatBytes,
    parseFlacBitDepth,
    parseWavFmt
} from './utils/AudioUtils';
import {
    decoderForExtension,
    formatNotSupportedMessage
} from './utils/AudioDecoderRouter';
import type {
    AudioControllerState,
    VisualizationMode,
    RegionLike
} from './managers/types';

export interface AudioControllerHandle {
    dispose(): void;
}

const VIEWER_HTML = `
  <div class="audio-container" data-view-mode="waveform">
    <div class="audio-header">
      <div class="audio-title js-title"></div>
      <button type="button" class="audio-btn js-download-btn" title="Download audio file">Download</button>
    </div>
    <div class="audio-main-content">
      <div class="audio-file-info js-file-info" style="display: none;">
        <div class="audio-file-info-item">
          <div class="audio-file-info-label">Duration</div>
          <div class="audio-file-info-value js-duration-info">--:--</div>
        </div>
        <div class="audio-file-info-item">
          <div class="audio-file-info-label">Sample Rate</div>
          <div class="audio-file-info-value js-sample-rate-info">--</div>
        </div>
        <div class="audio-file-info-item">
          <div class="audio-file-info-label">Channels</div>
          <div class="audio-file-info-value js-channels-info">--</div>
          <div class="audio-file-info-subvalue js-channel-details-info" style="display:none;"></div>
        </div>
        <div class="audio-file-info-item">
          <div class="audio-file-info-label">Bit Depth</div>
          <div class="audio-file-info-value js-bit-depth-info">--</div>
        </div>
        <div class="audio-file-info-item">
          <div class="audio-file-info-label">File Size</div>
          <div class="audio-file-info-value js-file-size-info">--</div>
        </div>
        <div class="audio-file-info-item">
          <div class="audio-file-info-label">Format</div>
          <div class="audio-file-info-value js-format-info">--</div>
        </div>
      </div>

      <div class="audio-playback-controls">
        <button type="button" class="audio-btn audio-icon-btn js-play-pause" aria-label="Play">
          <svg class="audio-icon audio-icon-play" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"/></svg>
          <svg class="audio-icon audio-icon-pause" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>
        </button>
        <button type="button" class="audio-btn audio-icon-btn js-stop" aria-label="Stop">
          <svg class="audio-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6h12v12H6z"/></svg>
        </button>

        <div class="audio-volume-control">
          <label aria-label="Volume">🔊</label>
          <input type="range" class="audio-volume-slider js-volume" min="0" max="1" step="0.1" value="0.5">
        </div>

        <div class="audio-control-group">
          <label>Speed:</label>
          <select class="audio-scale-selector js-playback-speed" id="playbackSpeed">
            <option value="0.25">0.25x</option>
            <option value="0.5">0.5x</option>
            <option value="0.75">0.75x</option>
            <option value="1" selected>1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
            <option value="4">4x</option>
          </select>
        </div>

        <div class="audio-control-group js-loop-controls" style="display: none;">
          <label>Loop:</label>
          <input type="checkbox" class="js-loop-enabled">
        </div>

        <div class="audio-control-group js-zoom-controls" style="display: none;">
          <button type="button" class="audio-btn audio-zoom-btn js-zoom-out">−</button>
          <span class="audio-zoom-label js-zoom-level">30s</span>
          <button type="button" class="audio-btn audio-zoom-btn js-zoom-in">+</button>
        </div>

        <div class="audio-view-mode-control js-visualization-mode" role="group" aria-label="Visualization mode">
          <button type="button" class="audio-view-mode-btn active" data-view-mode="waveform" aria-pressed="true" aria-label="Waveform only"><span class="audio-view-mode-icon waveform-icon"><span></span><span></span><span></span><span></span><span></span></span></button>
          <button type="button" class="audio-view-mode-btn" data-view-mode="spectrogram" aria-pressed="false" aria-label="Spectrogram only"><span class="audio-view-mode-icon spectrogram-icon">▦</span></button>
          <button type="button" class="audio-view-mode-btn" data-view-mode="both" aria-pressed="false" aria-label="Waveform and spectrogram"><span class="audio-view-mode-icon both-icon">≋▦</span></button>
        </div>

        <div class="audio-control-group js-spectrogram-scale-group" style="display: none;">
          <label>Scale:</label>
          <select class="audio-scale-selector js-spectrogram-scale">
            <option value="linear">Linear</option>
            <option value="mel" selected>Mel</option>
            <option value="bark">Bark</option>
            <option value="erb">ERB</option>
          </select>
        </div>
      </div>

      <div class="audio-waveform-container">
        <div class="audio-loading js-loading">Loading audio file...</div>
        <div class="audio-error js-error" style="display: none;"></div>
        <div class="js-minimap" style="display: none;"></div>
        <div class="js-timeline"></div>
        <div class="js-waveform"></div>
        <div class="js-spectrogram" style="display: none;"></div>
        <div class="audio-status js-status"></div>
      </div>
    </div>
    <div class="audio-context-menu js-context-menu"></div>
  </div>
`;

export class AudioController {
    private blobUrl: string | null = null;
    private file: File | null = null;
    private container: HTMLElement | null = null;
    private state!: AudioControllerState;
    private metadata!: AudioMetadata;
    private precomputedData: PrecomputedDataPayload | null = null;
    private waveSurferManager!: WaveSurferManager;
    private pluginManager!: PluginManager;
    private regionManager!: RegionManager;
    private audioContextManager!: AudioContextManager;
    private fileInfoManager!: FileInfoManager;
    private eventManager!: EventManager;
    private contextMenuManager!: ContextMenuManager;
    private disposed = false;

    /**
     * Mount the audio viewer into `container`, using `file` as the source.
     */
    async start(file: File, container: HTMLElement): Promise<void> {
        this.file = file;
        this.container = container;
        this.disposed = false;
        container.classList.add('audio-viewer-host');
        container.innerHTML = VIEWER_HTML;

        const titleEl = container.querySelector<HTMLElement>('.js-title');
        if (titleEl) titleEl.textContent = file.name;
        container.querySelector<HTMLButtonElement>('.js-download-btn')?.addEventListener('click', () => {
            const url = URL.createObjectURL(file);
            const link = document.createElement('a');
            link.href = url; link.download = file.name; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });

        this.metadata = {
            fileName: file.name,
            format: AudioUtils.detectFormatFromFileName(file.name),
            fileSize: formatBytes(file.size),
            ...DOMUtils.getMetadata(container)
        };
        this.precomputedData = DOMUtils.getPrecomputedData(container);

        // Lossless container header probing. Compressed formats (MP3/AAC/
        // OGG/etc.) have no meaningful bit depth — leave metadata.bitDepth
        // unset so FileInfoManager renders "--". WAV is parsed inline; FLAC
        // bit depth is stubbed (see parseFlacBitDepth TODO).
        //
        // For WAV we also pull `sampleRate` and `channels` from the same
        // `fmt ` chunk so the file-info chips show the source file's real
        // metadata rather than the AudioContext's resample rate (which is
        // what wavesurfer's getDecodedData().sampleRate reports — see #84).
        // For other formats the chips fall back to the decoded AudioBuffer
        // values in FileInfoManager.
        if (!this.metadata.bitDepth || !this.metadata.sampleRate || !this.metadata.channels) {
            try {
                const headerSlice = await file.slice(0, 65536).arrayBuffer();
                const fmt = (this.metadata.format ?? '').toUpperCase();
                if (fmt === 'WAV') {
                    const wavFmt = parseWavFmt(headerSlice);
                    if (wavFmt) {
                        if (!this.metadata.bitDepth) this.metadata.bitDepth = wavFmt.bitsPerSample;
                        if (!this.metadata.sampleRate) this.metadata.sampleRate = wavFmt.sampleRate;
                        if (!this.metadata.channels) this.metadata.channels = wavFmt.numChannels;
                    }
                } else if (fmt === 'FLAC' && !this.metadata.bitDepth) {
                    const parsedBitDepth = parseFlacBitDepth(headerSlice);
                    if (parsedBitDepth != null) {
                        this.metadata.bitDepth = parsedBitDepth;
                    }
                }
            } catch (err) {
                console.warn('Audio header probe failed:', err);
            }
        }

        const elements = DOMUtils.getElements(container);
        this.state = {
            wavesurfer: null,
            spectrogramPlugin: null,
            timelinePlugin: null,
            regionsPlugin: null,
            spectrogramSplitChannels: false,
            visualizationMode: 'waveform',
            isPlaying: false,
            loopEnabled: false,
            isSetupComplete: false,
            audioContextInitialized: false,
            selectedRegionId: null,
            regionStartOverlay: null,
            regionEndOverlay: null,
            regionDurationOverlay: null,
            loadTimeoutId: null,
            elements,
            root: container,
            // Filled in below.
            regionManager: null as unknown as AudioControllerState['regionManager']
        };

        this.audioContextManager = new AudioContextManager(this.state);
        this.waveSurferManager = new WaveSurferManager(this.state);
        this.regionManager = new RegionManager(this.state);
        this.fileInfoManager = new FileInfoManager(this.state, this.metadata);
        this.pluginManager = new PluginManager(this.state, this.waveSurferManager);
        this.eventManager = new EventManager(
            this.state,
            this.audioContextManager,
            this.regionManager,
            this.waveSurferManager
        );
        // ContextMenuManager owns the right-click menu + ESC/outside-click
        // dismissal (issue #27). It depends on `regionsPlugin` being live,
        // so we mount it lazily after the initialisation path that wires
        // regions; here we just construct it.
        this.contextMenuManager = new ContextMenuManager(this.state);

        this.state.audioContextManager = this.audioContextManager;
        this.state.regionManager = this.regionManager;
        this.state.fileInfoManager = this.fileInfoManager;
        this.state.pluginManager = this.pluginManager;
        this.state.audioController = {
            setVisualizationMode: (mode: string) => this.setVisualizationMode(mode),
            showLoadError: (message: string) => this.showLoadError(message),
            extractAndDownloadRegion: (region: RegionLike) => this.extractAndDownloadRegion(region)
        };

        this.blobUrl = URL.createObjectURL(file);

        await this.initAudioViewer();
    }

    private clearLoadTimeout(): void {
        if (this.state.loadTimeoutId) {
            clearTimeout(this.state.loadTimeoutId);
            this.state.loadTimeoutId = null;
        }
    }

    private startLoadTimeout(): void {
        this.clearLoadTimeout();
        this.state.loadTimeoutId = setTimeout(() => {
            if (this.state.isSetupComplete) return;
            this.showLoadError(
                'Audio decode timed out. This format may not be supported by Chrome.'
            );
        }, 15000);
    }

    private showLoadError(message: string): void {
        this.clearLoadTimeout();
        const loading = this.state.elements.loading;
        const error = this.state.elements.error;
        if (loading) loading.style.display = 'none';
        if (error) {
            error.style.display = 'block';
            error.textContent = message;
        }
    }

    private async initAudioViewer(): Promise<void> {
        if (!this.blobUrl) {
            this.showLoadError('Audio source is not available.');
            return;
        }

        // Issue #26: gate the WaveSurfer load behind the decoder router.
        // 'wasm-stub' formats (PCM/AMR/AWB) and unrecognized extensions
        // would otherwise be handed to <audio>, which produces a generic
        // decode error several seconds later. Short-circuit with a
        // friendly panel up front instead.
        const fileName = this.file?.name ?? '';
        const decoderKind = decoderForExtension(fileName);
        if (decoderKind !== 'native') {
            this.showLoadError(formatNotSupportedMessage(fileName));
            return;
        }

        try {
            this.regionManager.clearRegionsFromDOM();

            if (this.precomputedData?.mode === 'precomputed') {
                await this.initPrecomputedMode();
            } else if (this.precomputedData?.mode === 'streaming') {
                await this.initStreamingMode();
            } else {
                await this.initDefaultMode();
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Error loading audio:', error);
            this.showLoadError('Error loading audio file: ' + message);
        }
    }

    private shouldSplitChannels(decodedData: AudioBuffer | null = null): boolean {
        return (decodedData?.numberOfChannels ?? this.metadata.channels ?? 0) === 2;
    }

    private applyChannelRendering(splitChannels: boolean): void {
        this.state.spectrogramSplitChannels = splitChannels;
        const waveformEl = this.state.elements.waveform;
        const spectrogramEl = this.state.elements.spectrogram;
        waveformEl?.classList.toggle('split-channels', splitChannels);
        spectrogramEl?.classList.toggle('split-channels', splitChannels);

        if (this.state.wavesurfer?.setOptions) {
            this.state.wavesurfer.setOptions({
                splitChannels: splitChannels
                    ? this.waveSurferManager.getSplitChannelOptions()
                    : undefined
            });
        }
    }

    setVisualizationMode(mode: string): void {
        const normalized = normalizeVisualizationMode(mode);
        this.state.visualizationMode = normalized;

        const { showWaveform, showSpectrogram } = visualizationModeLayers(normalized);
        const { spectrogramScaleGroup, visualizationModeButtons } = this.state.elements;

        // Source of truth — CSS rules in audioViewer.css gate the waveform
        // canvases and the spectrogram wrapper based on this attribute. The
        // imperative helpers below remain as a belt-and-suspenders fallback
        // for cases where the wavesurfer / spectrogram plugin DOM hasn't
        // settled into the expected shape yet.
        const container = this.state.root?.querySelector<HTMLElement>('.audio-container');
        if (container) container.dataset.viewMode = normalized;

        this.setWaveformLayersVisible(showWaveform);
        this.setSpectrogramLayerVisible(showSpectrogram);
        if (spectrogramScaleGroup) {
            spectrogramScaleGroup.style.display = showSpectrogram ? 'flex' : 'none';
        }
        Array.from(visualizationModeButtons || []).forEach((button) => {
            const el = button as HTMLElement;
            const isActive = el.dataset.viewMode === normalized;
            el.classList.toggle('active', isActive);
            el.setAttribute('aria-pressed', String(isActive));
        });

        if (showSpectrogram && this.state.spectrogramPlugin) {
            setTimeout(() => {
                if (this.state.spectrogramPlugin) {
                    void this.state.spectrogramPlugin.render();
                }
            }, 100);
        }

        // Refresh region overlays since the layout shifted.
        const regionUpdate = (): void => this.regionManager.updateSelectedRegionOverlays();
        requestAnimationFrame(regionUpdate);
        setTimeout(regionUpdate, 120);
    }

    private setWaveformLayersVisible(visible: boolean): void {
        const wrapper = this.state.wavesurfer?.getWrapper?.();
        if (!wrapper) return;
        ['.canvases', '.progress', '.cursor'].forEach((selector) => {
            const el = wrapper.querySelector<HTMLElement>(selector);
            if (el) el.style.display = visible ? '' : 'none';
        });
    }

    private setSpectrogramLayerVisible(visible: boolean): void {
        const wrapper = this.state.spectrogramPlugin?.wrapper;
        if (wrapper) wrapper.style.display = visible ? 'block' : 'none';
    }

    private showViewerContent(): void {
        if (this.state.elements.loading) {
            this.state.elements.loading.style.display = 'none';
        }
        this.setVisualizationMode(this.state.visualizationMode || 'waveform');
    }

    private async initDefaultMode(): Promise<void> {
        if (!this.blobUrl) return;
        this.state.wavesurfer = await this.waveSurferManager.create({
            splitChannels: this.shouldSplitChannels()
        });

        const loadAudio = async (): Promise<void> => {
            this.state.isSetupComplete = false;
            this.startLoadTimeout();
            this.regionManager.clearAllRegions();
            await this.state.wavesurfer!.load(this.blobUrl!);
            await new Promise((resolve) => setTimeout(resolve, 100));
            this.audioContextManager.checkState();
        };

        // Keyboard up first so the user can hit space immediately.
        this.eventManager.setupKeyboardEvents();

        loadAudio().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('Preload failed:', error);
            AudioUtils.showStatus(
                'Preload failed: ' + message,
                this.state.elements.status
            );
        });

        const setupAfterDecode = async (): Promise<void> => {
            if (this.state.isSetupComplete) return;
            this.state.isSetupComplete = true;
            this.clearLoadTimeout();

            const decodedData = this.state.wavesurfer?.getDecodedData?.() ?? null;
            const splitChannels = this.shouldSplitChannels(decodedData);
            this.applyChannelRendering(splitChannels);

            await this.pluginManager.setupSpectrogram({ splitChannels });
            await this.pluginManager.setupTimeline();
            await this.pluginManager.setupRegions();

            this.showViewerContent();

            this.eventManager.setupPlayPause();
            this.eventManager.setupStop();
            this.eventManager.setupVolume();
            this.eventManager.setupLoop();
            this.eventManager.setupSpectrogramScale();
            this.eventManager.setupPlaybackSpeed();
            this.eventManager.setupVisualizationMode();
            this.eventManager.setupWaveSurferEvents();
            this.contextMenuManager.mountContextMenu();

            this.fileInfoManager.updateDuration();
            this.fileInfoManager.updateFileInfo();
        };

        this.state.wavesurfer.on('ready', () => void setupAfterDecode());
        this.state.wavesurfer.on('decode', () => void setupAfterDecode());
    }

    private async initPrecomputedMode(): Promise<void> {
        // Currently unreachable on Chrome (DOMUtils.getPrecomputedData
        // returns null). Kept for parity with the VSCode controller.
        const data = this.precomputedData;
        if (!data || data.mode !== 'precomputed' || !this.blobUrl) return;
        if (!data.peaks || !data.duration) return;

        this.state.wavesurfer = await this.waveSurferManager.createPrecomputed({
            url: this.blobUrl,
            peaks: data.peaks,
            duration: data.duration
        });

        this.eventManager.setupKeyboardEvents();

        const setupAfterReady = async (): Promise<void> => {
            if (this.state.isSetupComplete) return;
            this.state.isSetupComplete = true;

            if (data.spectrogram && data.spectrogram.length > 0 && data.sampleRate) {
                await this.pluginManager.setupSpectrogramPrecomputed(
                    data.spectrogram,
                    data.sampleRate
                );
            }
            await this.pluginManager.setupTimeline();
            await this.pluginManager.setupRegions();

            this.showViewerContent();
            const minimapEl = this.state.elements.minimap;
            if (minimapEl) minimapEl.style.display = 'block';

            this.eventManager.setupPlayPause();
            this.eventManager.setupStop();
            this.eventManager.setupVolume();
            this.eventManager.setupLoop();
            this.eventManager.setupSpectrogramScale();
            this.eventManager.setupPlaybackSpeed();
            this.eventManager.setupVisualizationMode();
            this.eventManager.setupZoom(data.duration!);
            this.eventManager.setupWaveSurferEvents();
            this.contextMenuManager.mountContextMenu();

            this.fileInfoManager.updateDuration(data.duration);
            this.fileInfoManager.updateFileInfo();
        };

        this.state.wavesurfer.on('ready', () => void setupAfterReady());
        this.state.wavesurfer.on('decode', () => void setupAfterReady());
    }

    private async initStreamingMode(): Promise<void> {
        if (!this.blobUrl) return;
        this.state.wavesurfer = await this.waveSurferManager.createStreaming({
            url: this.blobUrl
        });

        this.eventManager.setupKeyboardEvents();

        const setupAfterDecode = async (): Promise<void> => {
            if (this.state.isSetupComplete) return;
            this.state.isSetupComplete = true;

            await this.pluginManager.setupSpectrogram();
            await this.pluginManager.setupTimeline();
            await this.pluginManager.setupRegions();

            this.showViewerContent();

            this.eventManager.setupPlayPause();
            this.eventManager.setupStop();
            this.eventManager.setupVolume();
            this.eventManager.setupLoop();
            this.eventManager.setupSpectrogramScale();
            this.eventManager.setupPlaybackSpeed();
            this.eventManager.setupVisualizationMode();
            this.eventManager.setupWaveSurferEvents();
            this.contextMenuManager.mountContextMenu();

            const duration = this.state.wavesurfer?.getDuration() ?? 0;
            if (duration > 60) this.eventManager.setupZoom(duration);

            this.fileInfoManager.updateDuration();
            this.fileInfoManager.updateFileInfo();
        };

        this.state.wavesurfer.on('decode', () => void setupAfterDecode());
        this.state.wavesurfer.on('ready', () => void setupAfterDecode());
    }

    /**
     * Save a selected region as a stand-alone WAV file. Browser-only —
     * uses an `<a download>` link instead of the VSCode `postMessage`
     * round-trip the original used.
     */
    async extractAndDownloadRegion(region: RegionLike): Promise<void> {
        if (!region || !this.state.wavesurfer) return;
        try {
            AudioUtils.showStatus('Extracting audio region...', this.state.elements.status);
            const decodedData = this.state.wavesurfer.getDecodedData?.();
            if (!decodedData) throw new Error('Audio data not available');

            const sampleRate = decodedData.sampleRate;
            const numberOfChannels = decodedData.numberOfChannels;
            const startSample = Math.floor(region.start * sampleRate);
            const endSample = Math.floor(region.end * sampleRate);
            const length = endSample - startSample;
            if (length <= 0) throw new Error('Region duration is zero');

            const channels: Float32Array[] = [];
            for (let c = 0; c < numberOfChannels; c++) {
                const channelData = decodedData.getChannelData(c);
                const extractedData = new Float32Array(length);
                for (let i = 0; i < length; i++) {
                    extractedData[i] = channelData[startSample + i] || 0;
                }
                channels.push(extractedData);
            }

            const wav = this.audioBufferToWav({
                length,
                numberOfChannels,
                sampleRate,
                getChannelData: (c: number) => channels[c]
            });
            const blob = new Blob([wav], { type: 'audio/wav' });

            const baseName = (this.file?.name ?? 'audio_file').replace(/\.[^/.]+$/, '');
            const fileName = `${baseName}_${region.start.toFixed(2)}s-${region.end.toFixed(2)}s.wav`;

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 100);

            AudioUtils.showStatus(`Saved ${fileName}`, this.state.elements.status);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Error extracting region:', error);
            AudioUtils.showStatus('Error extracting region: ' + message, this.state.elements.status);
        }
    }

    private audioBufferToWav(buffer: {
        length: number;
        numberOfChannels: number;
        sampleRate: number;
        getChannelData: (c: number) => Float32Array;
    }): ArrayBuffer {
        const length = buffer.length;
        const numberOfChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const bytesPerSample = 2;
        const blockAlign = numberOfChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = length * blockAlign;
        const bufferSize = 44 + dataSize;
        const arrayBuffer = new ArrayBuffer(bufferSize);
        const view = new DataView(arrayBuffer);

        const writeString = (offset: number, s: string): void => {
            for (let i = 0; i < s.length; i++) {
                view.setUint8(offset + i, s.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, bufferSize - 8, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numberOfChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, dataSize, true);

        let offset = 44;
        for (let i = 0; i < length; i++) {
            for (let c = 0; c < numberOfChannels; c++) {
                const sample = Math.max(-1, Math.min(1, buffer.getChannelData(c)[i]));
                view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
                offset += 2;
            }
        }
        return arrayBuffer;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        try {
            this.contextMenuManager?.dispose();
        } catch (err) {
            console.warn('ContextMenuManager dispose failed:', err);
        }
        try {
            this.state?.wavesurfer?.destroy?.();
        } catch (err) {
            console.warn('WaveSurfer destroy failed:', err);
        }
        if (this.blobUrl) {
            URL.revokeObjectURL(this.blobUrl);
            this.blobUrl = null;
        }
        this.clearLoadTimeout();
        if (this.container) {
            this.container.classList.remove('audio-viewer-host');
            this.container.innerHTML = '';
        }
    }
}

/**
 * Convenience factory used by the entry module's provider wiring. Returns
 * a handle whose `dispose()` tears the viewer down so the router can swap
 * to the next file cleanly.
 */
export async function mountAudioViewer(
    file: File,
    container: HTMLElement
): Promise<AudioControllerHandle> {
    const controller = new AudioController();
    await controller.start(file, container);
    return {
        dispose: () => controller.dispose()
    };
}

/**
 * Clamp arbitrary input to the three supported visualization modes. Anything
 * not in {'waveform', 'spectrogram', 'both'} falls back to 'waveform', which
 * matches the default selected button in the toolbar.
 *
 * Exported so unit tests can pin the contract without spinning up the full
 * controller.
 */
export function normalizeVisualizationMode(mode: string): VisualizationMode {
    return mode === 'waveform' || mode === 'spectrogram' || mode === 'both'
        ? mode
        : 'waveform';
}

/**
 * Pure mapping from a normalized visualization mode to which visual layers
 * should be visible. `waveform` shows only the waveform canvases,
 * `spectrogram` shows only the spectrogram, and `both` shows them together.
 *
 * Kept separate from the DOM toggle so it can be tested in isolation and so
 * the CSS rules in audioViewer.css can mirror the same mapping by data
 * attribute without duplicating the truth.
 */
export function visualizationModeLayers(mode: VisualizationMode): {
    showWaveform: boolean;
    showSpectrogram: boolean;
} {
    return {
        showWaveform: mode === 'waveform' || mode === 'both',
        showSpectrogram: mode === 'spectrogram' || mode === 'both'
    };
}
