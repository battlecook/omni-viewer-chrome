// FileInfoManager — populates the duration / sample-rate / channels /
// bit-depth / format / size strip in the audio viewer header.
//
// Port of vscode-omni-viewer's AudioController/managers/FileInfoManager.js,
// with VSCode metadata-server fallbacks replaced by File-handle inspection.

import { CONSTANTS } from '../utils/Constants';
import {
    AudioUtils,
    formatBytes,
    formatChannelLayout,
    formatDurationCompact,
    formatSampleRate
} from '../utils/AudioUtils';
import type { AudioMetadata } from '../utils/DOMUtils';
import type { AudioControllerState } from './types';

interface ChannelStats {
    peak: string;
    rms: string;
}

export class FileInfoManager {
    private readonly state: AudioControllerState;
    private readonly metadata: AudioMetadata;

    constructor(state: AudioControllerState, audioMetadata: AudioMetadata) {
        this.state = state;
        this.metadata = audioMetadata;
    }

    updateDuration(durationFromMetadata: number | null = null): void {
        let duration = durationFromMetadata;
        if (duration == null) {
            duration = this.state.wavesurfer?.getDuration() ?? null;
        }
        if (duration && Number.isFinite(duration)) {
            const el = this.state.elements.durationInfo;
            if (el) el.textContent = formatDurationCompact(duration);
        }
    }

    updateFileInfo(): void {
        try {
            let decodedData: AudioBuffer | null = null;
            try {
                decodedData = this.state.wavesurfer?.getDecodedData?.() ?? null;
            } catch {
                /* swallow — decodedData stays null */
            }

            const sampleRate =
                this.metadata.sampleRate ||
                decodedData?.sampleRate ||
                CONSTANTS.WAVESURFER.SAMPLE_RATE;
            const channels =
                this.metadata.channels ?? decodedData?.numberOfChannels ?? 2;
            const format = this.metadata.format ?? AudioUtils.detectFormatFromFileName(
                this.metadata.fileName ?? ''
            );
            // Bit depth only meaningful for lossless containers. The
            // controller pre-populates `metadata.bitDepth` for WAV/FLAC by
            // parsing the file header (FLAC is currently stubbed). For
            // anything else we render "--" rather than the misleading "32"
            // (which was the WebAudio Float32 channel-data heuristic).
            const bitDepth =
                this.metadata.bitDepth ??
                this.bitDepthFromHeaderOrNull(format);
            const fileSize =
                this.metadata.fileSize ??
                (decodedData ? this.estimateFileSize(decodedData) : '--');

            // Prefer wavesurfer's actual duration (reliable in streaming mode).
            const wsDuration = this.state.wavesurfer?.getDuration?.();
            const duration =
                wsDuration && wsDuration > 0 && Number.isFinite(wsDuration)
                    ? wsDuration
                    : this.metadata.duration ??
                      (decodedData ? decodedData.length / sampleRate : null);

            const el = this.state.elements;
            if (el.sampleRateInfo) {
                el.sampleRateInfo.textContent = formatSampleRate(sampleRate);
            }
            if (el.channelsInfo) {
                // Show "Stereo (2)" / "Mono (1)" / "5.1 Surround (6)" — the
                // raw count is kept in parentheses so users can still see the
                // exact channel number at a glance.
                const layout = formatChannelLayout(channels);
                el.channelsInfo.textContent =
                    channels && layout !== '--'
                        ? `${layout} (${channels})`
                        : String(channels || '--');
            }
            if (el.bitDepthInfo) {
                el.bitDepthInfo.textContent =
                    bitDepth == null ? '--' : `${bitDepth} bit`;
            }
            if (el.formatInfo) el.formatInfo.textContent = format || '--';
            if (el.fileSizeInfo) el.fileSizeInfo.textContent = fileSize || '--';

            this.updateChannelDetails(decodedData);

            if (duration != null) {
                this.updateDuration(duration);
            } else {
                this.updateDuration();
            }

            if (el.fileInfo) el.fileInfo.style.display = 'flex';
        } catch (error) {
            console.warn('Error updating file info:', error);
        }
    }

    /**
     * Bit depth fallback for when the controller didn't pre-populate
     * `metadata.bitDepth`. Compressed formats (MP3/AAC/OGG/M4A/WEBM) return
     * null so the UI shows "--". Lossless formats also return null here —
     * the canonical value comes from the header parse done by the
     * controller; this keeps a stale state from leaking the old "32" guess.
     */
    private bitDepthFromHeaderOrNull(_format: string | undefined): number | null {
        return null;
    }

    private updateChannelDetails(decodedData: AudioBuffer | null): void {
        const el = this.state.elements.channelDetailsInfo;
        if (!el) return;

        const channelCount =
            decodedData?.numberOfChannels ?? this.metadata.channels ?? 0;
        if (!decodedData || channelCount !== 2) {
            el.textContent = '';
            el.style.display = 'none';
            return;
        }

        const left = this.getChannelStats(decodedData.getChannelData(0));
        const right = this.getChannelStats(decodedData.getChannelData(1));
        el.textContent = `L peak ${left.peak}, RMS ${left.rms} | R peak ${right.peak}, RMS ${right.rms}`;
        el.style.display = 'block';
    }

    private getChannelStats(channelData: Float32Array | null | undefined): ChannelStats {
        if (!channelData || channelData.length === 0) {
            return { peak: '--', rms: '--' };
        }
        const maxSamples = 200000;
        const step = Math.max(1, Math.ceil(channelData.length / maxSamples));
        let peak = 0;
        let sumSquares = 0;
        let count = 0;
        for (let i = 0; i < channelData.length; i += step) {
            const value = channelData[i] || 0;
            const abs = Math.abs(value);
            if (abs > peak) peak = abs;
            sumSquares += value * value;
            count++;
        }
        const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
        return {
            peak: this.formatAmplitude(peak),
            rms: this.formatAmplitude(rms)
        };
    }

    private formatAmplitude(value: number): string {
        if (!Number.isFinite(value)) return '--';
        return value.toFixed(3);
    }

    private estimateFileSize(decodedData: AudioBuffer | null): string {
        if (!decodedData) return '--';
        const estimatedSize =
            decodedData.length * decodedData.numberOfChannels * 2;
        return formatBytes(estimatedSize);
    }
}
