// RegionManager — drag-selection regions + region-bar UI overlays.
//
// Port of vscode-omni-viewer's AudioController/managers/RegionManager.js.

import { CONSTANTS } from '../utils/Constants';
import { AudioUtils } from '../utils/AudioUtils';
import type { AudioControllerState, RegionLike } from './types';

interface NormalizedBounds {
    start: number;
    end: number;
}

export class RegionManager {
    private readonly state: AudioControllerState;
    private overlayRegionListenersCleanup: (() => void) | null = null;

    constructor(state: AudioControllerState) {
        this.state = state;
    }

    showControls(): void {
        const el = this.state.elements.loopControls;
        if (el) el.style.display = 'flex';
    }

    hideControls(): void {
        const el = this.state.elements.loopControls;
        if (el) el.style.display = 'none';
        this.removeOverlays();
    }

    createOverlays(region: RegionLike): void {
        this.removeOverlays();

        const waveformContainer = this.state.elements.waveform;
        const regionElement = region.element;
        if (!waveformContainer || !regionElement) return;

        const startOverlay = document.createElement('div');
        startOverlay.className = 'region-input-overlay region-start-overlay';
        startOverlay.innerHTML = `<input type="number" value="${region.start.toFixed(3)}" class="region-start-input" title="Start time">`;
        this.state.regionStartOverlay = startOverlay;

        const endOverlay = document.createElement('div');
        endOverlay.className = 'region-input-overlay region-end-overlay';
        endOverlay.innerHTML = `<input type="number" value="${region.end.toFixed(3)}" class="region-end-input" title="End time">`;
        this.state.regionEndOverlay = endOverlay;

        const durationOverlay = document.createElement('div');
        durationOverlay.className = 'region-input-overlay region-duration-overlay';
        durationOverlay.innerHTML = `<input type="number" value="${this.getRegionDuration(region).toFixed(3)}" class="region-duration-input" title="Duration">`;
        this.state.regionDurationOverlay = durationOverlay;

        waveformContainer.appendChild(startOverlay);
        waveformContainer.appendChild(endOverlay);
        waveformContainer.appendChild(durationOverlay);

        this.attachRegionOverlaySync(region);
        this.positionOverlays(region);
        this.setupOverlayEvents(region);
    }

    private attachRegionOverlaySync(region: RegionLike): void {
        if (this.overlayRegionListenersCleanup) {
            this.overlayRegionListenersCleanup();
            this.overlayRegionListenersCleanup = null;
        }
        if (!region?.on) return;

        const syncOverlays = (): void => this.updateOverlays(region);

        const unsubscribeUpdate = region.on('update', syncOverlays);
        const unsubscribeUpdateEnd = region.on('update-end', syncOverlays);

        this.overlayRegionListenersCleanup = (): void => {
            if (typeof unsubscribeUpdate === 'function') unsubscribeUpdate();
            if (typeof unsubscribeUpdateEnd === 'function') unsubscribeUpdateEnd();
        };
    }

    private positionOverlays(region: RegionLike): void {
        const startOverlay = this.state.regionStartOverlay;
        const endOverlay = this.state.regionEndOverlay;
        const durationOverlay = this.state.regionDurationOverlay;
        if (!startOverlay || !endOverlay || !durationOverlay) return;

        const regionElement = region.element;
        if (!regionElement) return;

        const overlayParent = startOverlay.offsetParent || startOverlay.parentElement;
        if (!overlayParent) return;

        const parentRect = (overlayParent as HTMLElement).getBoundingClientRect();
        const regionRect = regionElement.getBoundingClientRect();
        const startLeft = regionRect.left - parentRect.left - 10;
        const endLeft = regionRect.right - parentRect.left + 10;
        const durationLeft = regionRect.left - parentRect.left + regionRect.width / 2;
        const top = regionRect.top - parentRect.top + 10;
        const bottom = regionRect.bottom - parentRect.top + 10;

        startOverlay.style.left = `${startLeft}px`;
        startOverlay.style.top = `${bottom}px`;
        endOverlay.style.left = `${endLeft}px`;
        endOverlay.style.top = `${bottom}px`;
        durationOverlay.style.left = `${durationLeft}px`;
        durationOverlay.style.top = `${top}px`;
    }

    private setupOverlayEvents(region: RegionLike): void {
        const startOverlay = this.state.regionStartOverlay;
        const endOverlay = this.state.regionEndOverlay;
        const durationOverlay = this.state.regionDurationOverlay;
        if (!startOverlay || !endOverlay || !durationOverlay) return;

        const startInput = startOverlay.querySelector<HTMLInputElement>('.region-start-input');
        const endInput = endOverlay.querySelector<HTMLInputElement>('.region-end-input');
        const durationInput = durationOverlay.querySelector<HTMLInputElement>('.region-duration-input');
        if (!startInput || !endInput || !durationInput) return;

        const applyRegionInput = (startTimeInput: string, endTimeInput: string): void => {
            if (!region || !this.state.wavesurfer) return;
            let startSec = region.start;
            let endSec = region.end;
            const parsedStart = parseFloat(startTimeInput);
            const parsedEnd = parseFloat(endTimeInput);
            if (!Number.isNaN(parsedStart)) startSec = parsedStart;
            if (!Number.isNaN(parsedEnd)) endSec = parsedEnd;
            this.updateRegionBounds(startSec, endSec);
        };

        const applyDurationInput = (durationInputValue: string): void => {
            if (!region || !this.state.wavesurfer) return;
            const parsedDuration = parseFloat(durationInputValue);
            if (Number.isNaN(parsedDuration)) {
                this.updateOverlays(region);
                return;
            }
            const durationSec = Math.max(CONSTANTS.REGION.MIN_DURATION, parsedDuration);
            this.updateRegionBounds(region.start, region.start + durationSec, {
                preserveStart: true
            });
        };

        const handleStartInput = (e: Event): void => {
            const startValue = (e.target as HTMLInputElement).value;
            const endValue = endInput.value;
            applyRegionInput(startValue, endValue);
        };
        const handleEndInput = (e: Event): void => {
            const startValue = startInput.value;
            const endValue = (e.target as HTMLInputElement).value;
            applyRegionInput(startValue, endValue);
        };
        const handleDurationInput = (e: Event): void => {
            applyDurationInput((e.target as HTMLInputElement).value);
        };

        startInput.addEventListener('change', handleStartInput);
        startInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                (e.target as HTMLInputElement).blur();
                handleStartInput(e);
            }
        });
        endInput.addEventListener('change', handleEndInput);
        endInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                (e.target as HTMLInputElement).blur();
                handleEndInput(e);
            }
        });
        durationInput.addEventListener('change', handleDurationInput);
        durationInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                (e.target as HTMLInputElement).blur();
                handleDurationInput(e);
            }
        });
    }

    private updateOverlays(region: RegionLike): void {
        const start = this.state.regionStartOverlay;
        const end = this.state.regionEndOverlay;
        const dur = this.state.regionDurationOverlay;
        if (!start || !end || !dur) return;
        const startInput = start.querySelector<HTMLInputElement>('.region-start-input');
        const endInput = end.querySelector<HTMLInputElement>('.region-end-input');
        const durationInput = dur.querySelector<HTMLInputElement>('.region-duration-input');
        if (!startInput || !endInput || !durationInput) return;
        startInput.value = region.start.toFixed(3);
        endInput.value = region.end.toFixed(3);
        durationInput.value = this.getRegionDuration(region).toFixed(3);
        this.positionOverlays(region);
    }

    getRegionDuration(region: RegionLike): number {
        return Math.max(0, region.end - region.start);
    }

    private normalizeRegionBounds(
        startSec: number,
        endSec: number,
        options: { preserveStart?: boolean } = {}
    ): NormalizedBounds {
        const duration = this.state.wavesurfer?.getDuration() || 0;
        const minDuration = Math.min(CONSTANTS.REGION.MIN_DURATION, duration);

        if (duration <= 0) {
            return { start: 0, end: 0 };
        }

        let start = Number.isFinite(startSec) ? startSec : 0;
        let end = Number.isFinite(endSec) ? endSec : start + minDuration;

        if (!options.preserveStart && start > end) {
            const temp = start;
            start = end;
            end = temp;
        }

        start = Math.max(0, Math.min(duration, start));
        end = Math.max(0, Math.min(duration, end));

        if (options.preserveStart) {
            end = Math.min(duration, Math.max(start + minDuration, end));
            if (start + minDuration > end) {
                start = Math.max(0, end - minDuration);
            }
        } else if (start + minDuration > end) {
            end = Math.min(duration, start + minDuration);
            if (start + minDuration > end) {
                start = Math.max(0, end - minDuration);
            }
        }

        return { start, end };
    }

    private updateRegionBounds(
        startSec: number,
        endSec: number,
        options: { preserveStart?: boolean } = {}
    ): void {
        const normalized = this.normalizeRegionBounds(startSec, endSec, options);

        try {
            const regionsPlugin = this.state.regionsPlugin;
            if (regionsPlugin && regionsPlugin.getRegions) {
                const regions = regionsPlugin.getRegions();
                Object.values(regions).forEach((existingRegion) => existingRegion.remove());
            }

            if (regionsPlugin?.addRegion) {
                const newRegion = regionsPlugin.addRegion({
                    start: normalized.start,
                    end: normalized.end,
                    color: 'rgba(255, 0, 0, 0.1)'
                });
                this.state.selectedRegionId = newRegion.id;

                setTimeout(() => {
                    this.createOverlays(newRegion);
                }, 100);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('Failed to update region: ', err);
            AudioUtils.showStatus('Failed to update region: ' + message, this.state.elements.status);
        }
    }

    updateSelectedRegionOverlays(): void {
        const selectedRegion = this.getSelectedRegion();
        if (!selectedRegion) return;
        this.updateOverlays(selectedRegion);
    }

    removeOverlays(): void {
        if (this.overlayRegionListenersCleanup) {
            this.overlayRegionListenersCleanup();
            this.overlayRegionListenersCleanup = null;
        }
        if (this.state.regionStartOverlay) {
            this.state.regionStartOverlay.remove();
            this.state.regionStartOverlay = null;
        }
        if (this.state.regionEndOverlay) {
            this.state.regionEndOverlay.remove();
            this.state.regionEndOverlay = null;
        }
        if (this.state.regionDurationOverlay) {
            this.state.regionDurationOverlay.remove();
            this.state.regionDurationOverlay = null;
        }
    }

    getSelectedRegion(): RegionLike | null {
        const regionsPlugin = this.state.regionsPlugin;
        if (!regionsPlugin?.getRegions) return null;
        const regions = regionsPlugin.getRegions();
        if (!regions || Object.keys(regions).length === 0) return null;

        if (this.state.selectedRegionId && regions[this.state.selectedRegionId]) {
            return regions[this.state.selectedRegionId];
        }

        const regionIds = Object.keys(regions);
        if (regionIds.length > 0) {
            const lastRegion = regions[regionIds[regionIds.length - 1]];
            this.state.selectedRegionId = lastRegion.id;
            return lastRegion;
        }
        return null;
    }

    private stopPlaybackForReset(): void {
        if (this.state.wavesurfer && this.state.isPlaying) {
            this.state.wavesurfer.stop();
            this.state.isPlaying = false;
            const btn = this.state.elements.playPause;
            if (btn) {
                btn.textContent = '▶';
                btn.classList.remove('playing');
            }
        }
    }

    clearAllRegions(): void {
        this.stopPlaybackForReset();
        const regionsPlugin = this.state.regionsPlugin;
        if (regionsPlugin?.getRegions) {
            const regions = regionsPlugin.getRegions();
            if (regions && Object.keys(regions).length > 0) {
                Object.values(regions).forEach((region) => region.remove());
            }
        }
        this.state.selectedRegionId = null;
        this.removeOverlays();
        this.hideControls();
    }

    clearRegionsFromDOM(): void {
        this.stopPlaybackForReset();
        const waveformContainer = this.state.elements.waveform;
        if (waveformContainer) {
            const existingRegions = waveformContainer.querySelectorAll('.wavesurfer-region');
            existingRegions.forEach((region) => region.remove());
        }
        this.state.selectedRegionId = null;
        this.removeOverlays();
        this.hideControls();
    }
}
