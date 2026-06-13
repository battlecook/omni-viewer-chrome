// WaveSurferManager — owns the WaveSurfer instance + its options.
//
// Port of vscode-omni-viewer's AudioController/managers/WaveSurferManager.js.
//
// VSCode -> Chrome differences:
//   - WaveSurfer is loaded dynamically from `vendor/wavesurfer/` instead of
//     `node_modules`. See `../utils/wavesurferLoader.ts`.
//   - The audio source is provided as a blob URL constructed from the File
//     handle the router passes in (no `data:` URL inlining here).

import { CONSTANTS } from '../utils/Constants';
import { AudioUtils } from '../utils/AudioUtils';
import {
    loadHoverPlugin,
    loadMinimapPlugin,
    loadWaveSurfer,
    type WaveSurferConstructor,
    type WaveSurferInstance
} from '../utils/wavesurferLoader';
import type { AudioControllerState } from './types';

export interface SplitChannelOption {
    overlay: boolean;
    waveColor: string;
    progressColor: string;
}

export interface TimelineIntervals {
    timeInterval: number;
    primaryLabelInterval: number;
    secondaryLabelInterval: number;
}

export class WaveSurferManager {
    private readonly state: AudioControllerState;

    constructor(state: AudioControllerState) {
        this.state = state;
    }

    getSplitChannelOptions(): SplitChannelOption[] {
        return [
            {
                overlay: false,
                waveColor: CONSTANTS.WAVESURFER.WAVE_COLOR,
                progressColor: CONSTANTS.WAVESURFER.PROGRESS_COLOR
            },
            {
                overlay: false,
                waveColor: CONSTANTS.WAVESURFER.SECONDARY_WAVE_COLOR,
                progressColor: CONSTANTS.WAVESURFER.SECONDARY_PROGRESS_COLOR
            }
        ];
    }

    private waveformContainer(): HTMLElement {
        const el = this.state.elements.waveform;
        if (!el) {
            throw new Error('Audio viewer is missing its waveform container');
        }
        return el;
    }

    /**
     * Default mode: small files, WebAudio backend, full FFT/spectrogram
     * computation done client-side by wavesurfer's spectrogram plugin.
     */
    async create(opts: { splitChannels?: boolean } = {}): Promise<WaveSurferInstance> {
        const WaveSurfer = await loadWaveSurfer();
        const HoverPlugin = await loadHoverPlugin();

        const splitChannels = opts.splitChannels ?? false;

        return WaveSurfer.create({
            container: this.waveformContainer(),
            waveColor: CONSTANTS.WAVESURFER.WAVE_COLOR,
            progressColor: CONSTANTS.WAVESURFER.PROGRESS_COLOR,
            cursorColor: CONSTANTS.WAVESURFER.CURSOR_COLOR,
            barWidth: CONSTANTS.WAVESURFER.BAR_WIDTH,
            barRadius: CONSTANTS.WAVESURFER.BAR_RADIUS,
            cursorWidth: CONSTANTS.WAVESURFER.CURSOR_WIDTH,
            barGap: CONSTANTS.WAVESURFER.BAR_GAP,
            responsive: true,
            sampleRate: CONSTANTS.WAVESURFER.SAMPLE_RATE,
            normalize: true,
            backend: 'WebAudio',
            autoplay: false,
            mediaControls: false,
            hideScrollbar: false,
            interact: true,
            ...(splitChannels ? { splitChannels: this.getSplitChannelOptions() } : {}),
            plugins: [
                HoverPlugin.create({
                    lineWidth: 2,
                    labelBackground: '#000000',
                    labelColor: '#fff',
                    formatTimeCallback: AudioUtils.formatTime
                })
            ]
        });
    }

    /**
     * Precomputed mode: large files where WASM analysis pre-generated peaks
     * and spectrogram. MediaElement backend, minimap for navigation.
     *
     * **Chrome status (TODO):** the WASM analyzer in
     * `vendor/audio_engine_browser.js` is not yet wired into this Chrome
     * build, so this entry point is preserved for parity but is currently
     * unreachable from `index.ts`. A follow-up issue (large-file streaming)
     * will populate `getPrecomputedData` + flip on this branch. The code
     * below is the verbatim port so the wiring is one-line away.
     */
    async createPrecomputed(args: {
        url: string;
        peaks: number[][];
        duration: number;
    }): Promise<WaveSurferInstance> {
        const WaveSurfer = await loadWaveSurfer();
        const HoverPlugin = await loadHoverPlugin();
        const MinimapPlugin = await loadMinimapPlugin();

        const containerEl = this.waveformContainer();
        const containerWidth = containerEl.offsetWidth || 1000;
        const visibleSeconds = Math.min(30, args.duration);
        const minPxPerSec = containerWidth / visibleSeconds;

        // Fetch as blob to ensure seek works without HTTP Range support.
        const audio = new Audio();
        audio.preload = 'auto';
        try {
            const response = await fetch(args.url);
            const blob = await response.blob();
            audio.src = URL.createObjectURL(blob);
            AudioUtils.log('Audio loaded as blob URL for reliable seeking');
        } catch (e) {
            console.warn('Blob fetch failed, using direct URL:', e);
            audio.src = args.url;
        }

        const minimapEl = this.state.elements.minimap;

        return WaveSurfer.create({
            container: containerEl,
            waveColor: CONSTANTS.WAVESURFER.WAVE_COLOR,
            progressColor: CONSTANTS.WAVESURFER.PROGRESS_COLOR,
            cursorColor: CONSTANTS.WAVESURFER.CURSOR_COLOR,
            barWidth: 1,
            barRadius: 1,
            cursorWidth: CONSTANTS.WAVESURFER.CURSOR_WIDTH,
            barGap: 1,
            responsive: true,
            normalize: true,
            backend: 'MediaElement',
            media: audio,
            peaks: args.peaks,
            duration: args.duration,
            minPxPerSec,
            autoScroll: true,
            autoCenter: true,
            autoplay: false,
            mediaControls: false,
            hideScrollbar: false,
            interact: true,
            plugins: [
                HoverPlugin.create({
                    lineWidth: 2,
                    labelBackground: '#000000',
                    labelColor: '#fff',
                    formatTimeCallback: AudioUtils.formatTime
                }),
                MinimapPlugin.create({
                    height: 40,
                    waveColor: '#3a366e',
                    progressColor: '#2a2546',
                    overlayColor: 'rgba(100, 100, 200, 0.15)',
                    container: minimapEl ?? undefined,
                    insertPosition: 'beforeend'
                })
            ]
        });
    }

    /**
     * Streaming mode: large file but WASM precompute failed. MediaElement
     * backend, no precomputed peaks; wavesurfer decodes progressively.
     */
    async createStreaming(args: { url: string }): Promise<WaveSurferInstance> {
        const WaveSurfer: WaveSurferConstructor = await loadWaveSurfer();
        const HoverPlugin = await loadHoverPlugin();

        const audio = new Audio();
        audio.preload = 'auto';
        try {
            const response = await fetch(args.url);
            const blob = await response.blob();
            audio.src = URL.createObjectURL(blob);
        } catch (e) {
            console.warn('Blob fetch failed, using direct URL:', e);
            audio.src = args.url;
        }

        return WaveSurfer.create({
            container: this.waveformContainer(),
            waveColor: CONSTANTS.WAVESURFER.WAVE_COLOR,
            progressColor: CONSTANTS.WAVESURFER.PROGRESS_COLOR,
            cursorColor: CONSTANTS.WAVESURFER.CURSOR_COLOR,
            barWidth: CONSTANTS.WAVESURFER.BAR_WIDTH,
            barRadius: CONSTANTS.WAVESURFER.BAR_RADIUS,
            cursorWidth: CONSTANTS.WAVESURFER.CURSOR_WIDTH,
            barGap: CONSTANTS.WAVESURFER.BAR_GAP,
            responsive: true,
            normalize: true,
            backend: 'MediaElement',
            media: audio,
            autoplay: false,
            mediaControls: false,
            hideScrollbar: false,
            interact: true,
            plugins: [
                HoverPlugin.create({
                    lineWidth: 2,
                    labelBackground: '#000000',
                    labelColor: '#fff',
                    formatTimeCallback: AudioUtils.formatTime
                })
            ]
        });
    }

    /**
     * Apply a playback rate to the live WaveSurfer instance, if present.
     *
     * Negative or non-finite values are clamped/ignored — the select markup
     * only emits valid positive numbers but defensive parsing keeps a stale
     * `<select>` value from putting the player in a stuck state. Pitch is
     * preserved (`preservePitch=true`) so 2x sounds like fast playback rather
     * than chipmunked audio.
     */
    setPlaybackRate(rate: number): void {
        const ws = this.state.wavesurfer;
        if (!ws) return;
        if (!Number.isFinite(rate) || rate <= 0) return;
        try {
            ws.setPlaybackRate(rate, true);
        } catch (err) {
            console.warn('setPlaybackRate failed:', err);
        }
    }

    /**
     * Choose a "nice" tick step for the timeline so labels don't crowd.
     * Mirrors the VSCode original's getTimelineIntervals.
     */
    getTimelineIntervals(durationSec: number): TimelineIntervals {
        if (!durationSec || durationSec <= 0) {
            return { timeInterval: 1, primaryLabelInterval: 5, secondaryLabelInterval: 1 };
        }

        const timelineEl = this.state.elements.timeline;
        const containerWidth = timelineEl?.offsetWidth || 1000;
        const pixelsPerSecond = containerWidth / durationSec;

        const niceSteps = CONSTANTS.TIMELINE.NICE_STEPS;
        let chosenStep: number = niceSteps[niceSteps.length - 1];
        for (const step of niceSteps) {
            if (step * pixelsPerSecond >= CONSTANTS.TIMELINE.MIN_TICK_PIXELS) {
                chosenStep = step;
                break;
            }
        }

        return {
            timeInterval: chosenStep,
            primaryLabelInterval: chosenStep * 5,
            secondaryLabelInterval: chosenStep
        };
    }
}
