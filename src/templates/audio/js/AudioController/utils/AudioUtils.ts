// Pure audio utility helpers (port of vscode-omni-viewer's AudioUtils.js).
//
// VSCode -> Chrome differences:
//   - The original `log` function checked a `vscode` global; here we just
//     guard with a debug flag so the helper stays inert in production.
//   - `showStatus` writes to a passed-in element; no dependency on vscode.

const DEBUG_AUDIO = false;

/**
 * Format a duration in seconds as `M:SS.mmm`.
 *
 * Examples:
 *   formatTime(0)       -> "0:00.000"
 *   formatTime(75.123)  -> "1:15.123"
 *   formatTime(1234.56) -> "20:34.560"
 *
 * Negative or non-finite inputs are clamped to 0 so callers never display
 * `NaN`. The output always includes 2-digit seconds and 3-digit milliseconds
 * for monospaced rendering.
 */
export function formatTime(seconds: number): string {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const minutes = Math.floor(safe / 60);
    const remainingSeconds = Math.floor(safe % 60);
    const milliseconds = Math.floor((safe % 1) * 1000);
    return (
        `${minutes}:` +
        `${remainingSeconds.toString().padStart(2, '0')}.` +
        `${milliseconds.toString().padStart(3, '0')}`
    );
}

/**
 * Format a duration as `M:SS` (no milliseconds). Used in the file-info bar.
 */
export function formatDurationCompact(seconds: number): string {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const minutes = Math.floor(safe / 60);
    const remainingSeconds = Math.floor(safe % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

/**
 * Format a sample-rate in Hz as a human-friendly kHz string. Falls back to
 * the raw Hz number when the value isn't usable.
 *
 * Examples:
 *   formatSampleRate(44100) -> "44.1 kHz"
 *   formatSampleRate(48000) -> "48 kHz"
 *   formatSampleRate(0)     -> "--"
 */
export function formatSampleRate(hz: number | null | undefined): string {
    if (!hz || !Number.isFinite(hz) || hz <= 0) {
        return '--';
    }
    const kHz = hz / 1000;
    // Drop the trailing `.0` when the rate is a whole kHz (e.g. 48000 -> "48 kHz").
    const formatted = Number.isInteger(kHz) ? `${kHz}` : kHz.toFixed(1);
    return `${formatted} kHz`;
}

/**
 * Format a byte count as KB / MB. Mirrors the heuristic from the VSCode
 * audio viewer's FileInfoManager.estimateFileSize.
 */
export function formatBytes(bytes: number | null | undefined): string {
    if (!bytes || !Number.isFinite(bytes) || bytes < 0) {
        return '--';
    }
    const kb = Math.round(bytes / 1024);
    const mb = bytes / (1024 * 1024);
    return mb > 1 ? `${mb.toFixed(1)} MB` : `${kb} KB`;
}

/**
 * Detect a human-readable format label from a file name (e.g. "song.MP3" ->
 * "MP3"). Falls back to "Unknown" if no extension is present.
 */
export function detectFormatFromFileName(fileName: string): string {
    const lower = (fileName || '').toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot < 0 || dot === lower.length - 1) {
        return 'Unknown';
    }
    const ext = lower.slice(dot + 1);
    const formatMap: Record<string, string> = {
        mp3: 'MP3',
        wav: 'WAV',
        flac: 'FLAC',
        ogg: 'OGG',
        aac: 'AAC',
        webm: 'WEBM',
        m4a: 'M4A',
        pcm: 'PCM'
    };
    return formatMap[ext] || ext.toUpperCase();
}

/**
 * Briefly flash a status message in the viewer's status pill. No-op when no
 * element is provided (callers don't have to null-check).
 */
export function showStatus(message: string, statusElement: HTMLElement | null | undefined): void {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.classList.add('show');
    // The VSCode original used 100ms — preserved verbatim. The CSS animation
    // takes care of the fade.
    setTimeout(() => {
        statusElement.classList.remove('show');
    }, 100);
}

export function log(message: string): void {
    if (DEBUG_AUDIO) {
        console.log(message);
    }
}

/**
 * Map a channel count to a human-readable layout label, mirroring the
 * common consumer-audio conventions:
 *
 *   1ch -> "Mono"
 *   2ch -> "Stereo"
 *   6ch -> "5.1 Surround"
 *   8ch -> "7.1 Surround"
 *   else -> "Nch" (e.g. 3ch -> "3ch", 4ch -> "4ch")
 *
 * Returns "--" when the input isn't a positive finite integer-like number,
 * so callers can use the result directly as the rendered text.
 */
export function formatChannelLayout(channels: number | null | undefined): string {
    if (channels == null || !Number.isFinite(channels) || channels <= 0) {
        return '--';
    }
    const n = Math.round(channels);
    switch (n) {
        case 1: return 'Mono';
        case 2: return 'Stereo';
        case 6: return '5.1 Surround';
        case 8: return '7.1 Surround';
        default: return `${n}ch`;
    }
}

/**
 * Parse a WAV file header to extract `bitsPerSample`. Returns null when the
 * buffer doesn't look like a RIFF/WAVE file or no `fmt ` chunk is found.
 *
 * Layout reference (RIFF/WAVE):
 *   bytes 0-3   "RIFF"
 *   bytes 4-7   chunk size (LE)
 *   bytes 8-11  "WAVE"
 *   then a sequence of `<id (4)><size (4 LE)><payload>` sub-chunks. We scan
 *   for the `fmt ` sub-chunk and read bitsPerSample from offset+14..+15
 *   (i.e. byte 22-23 of the fmt-chunk payload, which maps to the 16-bit
 *   `wBitsPerSample` field per the canonical PCM WAV spec). For WAVE_FORMAT_PCM
 *   files that's bytes 34-35 of the file when the `fmt ` chunk lives at the
 *   conventional offset 12, but we don't assume the conventional offset.
 */
export function parseWavBitDepth(arrayBuffer: ArrayBuffer | null | undefined): number | null {
    return parseWavFmt(arrayBuffer)?.bitsPerSample ?? null;
}

/**
 * Parsed fields from a WAV `fmt ` sub-chunk. All fields are positive
 * integers; the helper returns null when the buffer doesn't look like a
 * RIFF/WAVE file or the `fmt ` chunk is absent / truncated.
 *
 * The Chrome controller already reads a 64 KB header slice once (for bit
 * depth probing in AudioController.start) — this helper reuses those same
 * bytes to extract the source sample rate + channel count without
 * triggering a second decode. For non-WAV containers (MP3/AAC/OGG/FLAC/
 * WEBM/M4A) we fall back to wavesurfer's decoded AudioBuffer values in
 * FileInfoManager.
 */
export interface WavFmt {
    bitsPerSample: number;
    sampleRate: number;
    numChannels: number;
}

export function parseWavFmt(arrayBuffer: ArrayBuffer | null | undefined): WavFmt | null {
    if (!arrayBuffer || arrayBuffer.byteLength < 44) return null;
    try {
        const view = new DataView(arrayBuffer);
        const tag = (offset: number): string =>
            String.fromCharCode(
                view.getUint8(offset),
                view.getUint8(offset + 1),
                view.getUint8(offset + 2),
                view.getUint8(offset + 3)
            );
        if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

        // Walk the sub-chunk list looking for "fmt ".
        let offset = 12;
        const max = view.byteLength - 8;
        while (offset <= max) {
            const id = tag(offset);
            const size = view.getUint32(offset + 4, true);
            if (id === 'fmt ') {
                if (offset + 8 + 16 > view.byteLength) return null;
                // PCM `fmt ` payload layout (LE):
                //   +0  wFormatTag (uint16) — ignored here
                //   +2  nChannels (uint16)
                //   +4  nSamplesPerSec (uint32)
                //   +8  nAvgBytesPerSec (uint32)
                //   +12 nBlockAlign (uint16)
                //   +14 wBitsPerSample (uint16)
                const numChannels = view.getUint16(offset + 8 + 2, true);
                const sampleRate = view.getUint32(offset + 8 + 4, true);
                const bitsPerSample = view.getUint16(offset + 8 + 14, true);
                if (bitsPerSample <= 0 || sampleRate <= 0 || numChannels <= 0) {
                    return null;
                }
                return { bitsPerSample, sampleRate, numChannels };
            }
            // Chunks are word-aligned (RIFF spec): pad odd sizes by 1.
            offset += 8 + size + (size & 1);
        }
    } catch (err) {
        console.warn('parseWavFmt: failed to parse WAV header:', err);
    }
    return null;
}

/**
 * Parse a FLAC file header to extract bit depth from the STREAMINFO block.
 *
 * **Status: stubbed.** FLAC's STREAMINFO encodes `bitsPerSample - 1` as a
 * 5-bit field straddling bytes 16 and 17 of the block (within the larger
 * "fLaC" + metadata-block-list framing). Decoding it cleanly requires
 * bit-level reading and metadata-block iteration, which is out of scope for
 * this slice. The hook is in place so a follow-up issue can implement the
 * real parser without touching call sites.
 *
 * TODO(audio-flac-bit-depth): implement real parser using FLAC bitstream.
 */
export function parseFlacBitDepth(_arrayBuffer: ArrayBuffer | null | undefined): number | null {
    return null;
}

// Aggregate object so call sites that mirror the VSCode code (`AudioUtils.foo`)
// can keep their existing shape.
export const AudioUtils = {
    formatTime,
    formatDurationCompact,
    formatSampleRate,
    formatBytes,
    detectFormatFromFileName,
    formatChannelLayout,
    parseWavBitDepth,
    parseWavFmt,
    parseFlacBitDepth,
    showStatus,
    log
};
