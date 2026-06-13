// EventManager — keyboard / play / pause / space / volume / loop / zoom
// wiring + WaveSurfer event subscriptions.
//
// Port of vscode-omni-viewer's AudioController/managers/EventManager.js.

import { AudioUtils } from '../utils/AudioUtils';
import {
    applyShortcutAction,
    routeKeyboardEvent,
    type AudioShortcutHandle
} from '../utils/audioKeyboard';
import type { AudioControllerState } from './types';
import type { AudioContextManager } from './AudioContextManager';
import type { RegionManager } from './RegionManager';
import type { WaveSurferManager } from './WaveSurferManager';

export class EventManager {
    private readonly state: AudioControllerState;
    private readonly audioContextManager: AudioContextManager;
    private readonly regionManager: RegionManager;
    private readonly waveSurferManager: WaveSurferManager | null;
    private loopCheckInterval: ReturnType<typeof setInterval> | null = null;

    constructor(
        state: AudioControllerState,
        audioContextManager: AudioContextManager,
        regionManager: RegionManager,
        waveSurferManager?: WaveSurferManager
    ) {
        this.state = state;
        this.audioContextManager = audioContextManager;
        this.regionManager = regionManager;
        this.waveSurferManager = waveSurferManager ?? null;
    }

    setupPlayPause(): void {
        const btn = this.state.elements.playPause;
        if (!btn) return;
        btn.addEventListener('click', async () => {
            try {
                if (this.state.isPlaying) {
                    this.state.wavesurfer?.pause();
                    return;
                }
                if (!this.state.wavesurfer) return;

                if (!this.state.audioContextInitialized) {
                    await this.audioContextManager.initialize();
                }

                const ctx = this.audioContextManager.getWaveSurferAudioContext();
                if (ctx?.state === 'suspended') {
                    await ctx.resume();
                }

                const selectedRegion = this.regionManager.getSelectedRegion();
                if (selectedRegion) {
                    await this.state.wavesurfer.play(selectedRegion.start, selectedRegion.end);
                } else {
                    await this.state.wavesurfer.play();
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error('Playback error:', error);
                AudioUtils.showStatus('Playback error: ' + message, this.state.elements.status);
                if (message.includes('AudioContext') || message.includes('suspended')) {
                    this.state.audioContextInitialized = false;
                    await this.audioContextManager.initialize();
                }
            }
        });
    }

    setupStop(): void {
        const btn = this.state.elements.stop;
        if (!btn) return;
        btn.addEventListener('click', () => {
            this.state.wavesurfer?.stop();
        });
    }

    setupVolume(): void {
        const slider = this.state.elements.volume;
        if (!slider) return;
        slider.addEventListener('input', (e) => {
            const v = parseFloat((e.target as HTMLInputElement).value);
            this.state.wavesurfer?.setVolume(v);
        });
    }

    setupLoop(): void {
        const checkbox = this.state.elements.loopEnabled;
        if (!checkbox) return;
        checkbox.addEventListener('change', (e) => {
            this.state.loopEnabled = (e.target as HTMLInputElement).checked;
        });
    }

    /**
     * Wire the playback-speed select to the live WaveSurfer instance. The
     * select is always present (built into the toolbar markup); the handler
     * routes through `WaveSurferManager.setPlaybackRate` when available so
     * pitch preservation + clamping live in one place. Falls back to a
     * direct call when no manager was injected (older test paths).
     */
    setupPlaybackSpeed(): void {
        const select = this.state.elements.playbackSpeed;
        if (!select) return;
        select.addEventListener('change', (e) => {
            const target = e.target as HTMLSelectElement;
            const rate = parseFloat(target.value);
            if (!Number.isFinite(rate) || rate <= 0) return;
            if (this.waveSurferManager) {
                this.waveSurferManager.setPlaybackRate(rate);
            } else {
                this.state.wavesurfer?.setPlaybackRate(rate, true);
            }
        });
    }

    setupSpectrogramScale(): void {
        const select = this.state.elements.spectrogramScale;
        if (!select) return;
        select.addEventListener('change', async (e) => {
            const newScale = (e.target as HTMLSelectElement).value;
            if (this.state.pluginManager) {
                await this.state.pluginManager.changeSpectrogramScale(newScale);
                this.state.audioController?.setVisualizationMode?.(this.state.visualizationMode);
            }
        });
    }

    setupVisualizationMode(): void {
        const buttons = this.state.elements.visualizationModeButtons || [];
        Array.from(buttons).forEach((button) => {
            button.addEventListener('click', () => {
                const mode = (button as HTMLElement).dataset.viewMode;
                if (mode && this.state.audioController?.setVisualizationMode) {
                    this.state.audioController.setVisualizationMode(mode);
                }
            });
        });
    }

    setupZoom(duration: number): void {
        const { zoomControls, zoomIn, zoomOut, zoomLevel } = this.state.elements;
        if (!zoomControls || !zoomIn || !zoomOut) return;

        zoomControls.style.display = 'flex';

        const containerWidth = this.state.elements.waveform?.offsetWidth || 1000;
        const minZoom = containerWidth / duration;
        const maxZoom = containerWidth / 2;

        const updateLabel = (): void => {
            const ws = this.state.wavesurfer;
            if (!ws || !zoomLevel) return;
            const currentPxPerSec = ws.options.minPxPerSec || minZoom;
            const visibleSec = containerWidth / currentPxPerSec;
            zoomLevel.textContent =
                visibleSec >= 60
                    ? Math.round(visibleSec / 60) + 'm'
                    : Math.round(visibleSec) + 's';
        };

        zoomIn.addEventListener('click', () => {
            const ws = this.state.wavesurfer;
            if (!ws) return;
            const current = ws.options.minPxPerSec || minZoom;
            const next = Math.min(current * 2, maxZoom);
            ws.zoom(next);
            updateLabel();
        });
        zoomOut.addEventListener('click', () => {
            const ws = this.state.wavesurfer;
            if (!ws) return;
            const current = ws.options.minPxPerSec || minZoom;
            const next = Math.max(current / 2, minZoom);
            ws.zoom(next);
            updateLabel();
        });

        updateLabel();
    }

    /**
     * Document-level keyboard router for the audio viewer (issue #27).
     *
     * The full mapping lives in `../utils/audioKeyboard.ts` so it can be
     * unit tested without booting WaveSurfer; here we just wire the
     * router to the document and translate the resulting action into the
     * appropriate side-effect on the live state.
     *
     * Bindings:
     *   Space            -> play/pause (preserves AudioContext init/resume gating)
     *   ArrowLeft/Right  -> seek -5s / +5s
     *   Shift+Arrows     -> seek -0.5s / +0.5s
     *   `+` / `-`        -> waveform zoom in/out (clicks the toolbar zoom buttons)
     *   `L`              -> toggle loop region checkbox
     *
     * Inputs / textareas / selects / contenteditable elements bypass the
     * router (mirrors videoKeyboard).
     */
    setupKeyboardEvents(): void {
        document.addEventListener('keydown', async (e) => {
            const action = routeKeyboardEvent(e);
            if (!action) return;

            // Space needs the AudioContext to be live before we hand the
            // click off; everything else is independent of the audio
            // pipeline (seek/zoom/loop only mutate UI state or call
            // wavesurfer methods that don't require a running context).
            if (action.kind === 'play-toggle') {
                e.preventDefault();
                if (!this.state.audioContextInitialized) {
                    try {
                        await this.audioContextManager.initialize();
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error('AudioContext initialization failed on spacebar:', err);
                        AudioUtils.showStatus(
                            'AudioContext initialization failed: ' + message,
                            this.state.elements.status
                        );
                        return;
                    }
                }
                const ctx = this.audioContextManager.getWaveSurferAudioContext();
                if (ctx?.state === 'suspended') {
                    try {
                        await ctx.resume();
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error('Failed to resume AudioContext on spacebar:', err);
                        AudioUtils.showStatus(
                            'Failed to resume AudioContext: ' + message,
                            this.state.elements.status
                        );
                        return;
                    }
                }
            } else {
                e.preventDefault();
            }

            applyShortcutAction(action, this.buildShortcutHandle());
        });
    }

    /**
     * Construct the `AudioShortcutHandle` the dispatcher operates on.
     * Each method projects onto the live WaveSurfer / DOM so the pure
     * router stays decoupled from the running state.
     */
    private buildShortcutHandle(): AudioShortcutHandle {
        return {
            getCurrentTime: () => {
                try {
                    return this.state.wavesurfer?.getCurrentTime?.() ?? 0;
                } catch {
                    return 0;
                }
            },
            getDuration: () => {
                try {
                    return this.state.wavesurfer?.getDuration?.() ?? NaN;
                } catch {
                    return NaN;
                }
            },
            seekTo: (time: number) => {
                const ws = this.state.wavesurfer;
                if (!ws) return;
                const duration = (() => {
                    try {
                        return ws.getDuration?.() ?? 0;
                    } catch {
                        return 0;
                    }
                })();
                if (!Number.isFinite(duration) || duration <= 0) return;
                // WaveSurfer's `setTime` API isn't part of the typed
                // contract (it isn't always present on older builds), so
                // we use seekTo via the underlying media if available; the
                // common path is `ws.setTime(time)`. We try both, falling
                // back to the seek event the regions plugin emits. We use
                // a duck-typed cast since the Chrome bundle's wavesurfer
                // surface ships `setTime` and `seekTo`.
                const wsAny = ws as unknown as {
                    setTime?: (t: number) => void;
                    seekTo?: (ratio: number) => void;
                };
                if (typeof wsAny.setTime === 'function') {
                    wsAny.setTime(time);
                    return;
                }
                if (typeof wsAny.seekTo === 'function') {
                    wsAny.seekTo(Math.max(0, Math.min(1, time / duration)));
                }
            },
            togglePlay: () => {
                this.state.elements.playPause?.click();
            },
            zoomIn: () => {
                this.state.elements.zoomIn?.click();
            },
            zoomOut: () => {
                this.state.elements.zoomOut?.click();
            },
            toggleLoop: () => {
                const checkbox = this.state.elements.loopEnabled;
                if (!checkbox) {
                    this.state.loopEnabled = !this.state.loopEnabled;
                    return;
                }
                checkbox.checked = !checkbox.checked;
                this.state.loopEnabled = checkbox.checked;
                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            }
        };
    }

    setupWaveSurferEvents(): void {
        const ws = this.state.wavesurfer;
        if (!ws) return;

        const playBtn = this.state.elements.playPause;
        const setPlayState = (playing: boolean): void => {
            this.state.isPlaying = playing;
            if (!playBtn) return;
            // The button hosts both play and pause SVG icons; the `.playing`
            // class swaps which one is visible (see .audio-icon-btn rules in
            // audioViewer.css). aria-label tracks the action the button will
            // perform on next click so screen readers announce the correct
            // intent without depending on the icon swap.
            playBtn.classList.toggle('playing', playing);
            playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        };

        ws.on('play', () => setPlayState(true));
        ws.on('pause', () => setPlayState(false));
        ws.on('stop', () => setPlayState(false));

        ws.on('finish', () => {
            if (this.state.loopEnabled) {
                const selectedRegion = this.regionManager.getSelectedRegion();
                setTimeout(() => {
                    if (!this.state.wavesurfer) return;
                    if (selectedRegion) {
                        void this.state.wavesurfer.play(selectedRegion.start, selectedRegion.end);
                    } else {
                        void this.state.wavesurfer.play();
                    }
                }, 100);
            } else {
                setPlayState(false);
            }
        });

        // Loop polling. Mirrors the original VSCode setInterval-based approach.
        ws.on('play', () => {
            if (!this.state.loopEnabled || this.loopCheckInterval) return;
            this.loopCheckInterval = setInterval(() => {
                const ws2 = this.state.wavesurfer;
                if (!ws2 || !this.state.isPlaying || !this.state.loopEnabled) return;
                const currentTime = ws2.getCurrentTime();
                const selectedRegion = this.regionManager.getSelectedRegion();
                if (selectedRegion && selectedRegion.start !== undefined && selectedRegion.end !== undefined) {
                    if (currentTime >= selectedRegion.end - 0.1) {
                        void ws2.play(selectedRegion.start, selectedRegion.end);
                    }
                } else {
                    const duration = ws2.getDuration();
                    if (currentTime >= duration - 0.1) {
                        void ws2.play();
                    }
                }
            }, 100);
        });

        const clearLoop = (): void => {
            if (this.loopCheckInterval) {
                clearInterval(this.loopCheckInterval);
                this.loopCheckInterval = null;
            }
        };
        ws.on('pause', clearLoop);
        ws.on('stop', clearLoop);

        ws.on('error', (...args: unknown[]) => {
            const error = args[0];
            const errorMessage = error instanceof Error ? error.message : String(error);
            AudioUtils.showStatus('Error: ' + errorMessage, this.state.elements.status);
            if (!this.state.isSetupComplete && this.state.audioController?.showLoadError) {
                this.state.audioController.showLoadError(
                    `Unable to decode this audio file. ${errorMessage}.`
                );
            }
        });

        ws.on('ready', () => {
            setTimeout(() => {
                this.audioContextManager.checkState();
            }, 100);
        });

        ws.on('decode', () => {
            setTimeout(() => {
                this.state.fileInfoManager?.updateFileInfo();
            }, 100);
        });
    }
}
