// Browser-compatible MIME type helpers for omni-viewer-chrome.
// Ported from vscode-omni-viewer's fileUtils/media.ts, stripped of node:fs and
// child_process dependencies. The remaining helpers operate purely on file names.

const RAW_PCM_EXTENSION = '.pcm';
const RAW_PCM_SAMPLE_RATE = 16000;
const RAW_PCM_CHANNELS = 1;
const RAW_PCM_BIT_DEPTH = 16;

export interface AudioMetadata {
    sampleRate?: number;
    channels?: number;
    bitDepth?: number;
    duration?: number;
    format?: string;
    fileSize?: string;
}

export function extOf(name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith('.tar.gz')) {
        return '.tar.gz';
    }
    const dot = lower.lastIndexOf('.');
    return dot >= 0 ? lower.slice(dot) : '';
}

export function getAudioMimeType(fileName: string): string {
    const ext = extOf(fileName);
    const mimeTypes: { [key: string]: string } = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.pcm': 'audio/wav',
        '.aiff': 'audio/aiff',
        '.aif': 'audio/aiff',
        '.aifc': 'audio/aiff',
        '.amr': 'audio/amr',
        '.awb': 'audio/amr-wb',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac',
        '.ac3': 'audio/ac3',
        '.aac': 'audio/aac',
        '.m4a': 'audio/mp4'
    };
    return mimeTypes[ext] || 'audio/wav';
}

export function getVideoMimeType(fileName: string): string {
    const ext = extOf(fileName);
    const mimeTypes: { [key: string]: string } = {
        '.mp4': 'video/mp4',
        '.m4v': 'video/x-m4v',
        '.ts': 'video/mp2t',
        '.mts': 'video/mp2t',
        '.m2ts': 'video/mp2t',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.wmv': 'video/x-ms-wmv',
        '.flv': 'video/x-flv',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.ogv': 'video/ogg'
    };
    return mimeTypes[ext] || 'video/mp4';
}

export function getImageMimeType(fileName: string): string {
    const ext = extOf(fileName);
    const mimeTypes: { [key: string]: string } = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml'
    };
    return mimeTypes[ext] || 'image/jpeg';
}

export function formatFileSize(bytes: number): string {
    if (!bytes) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export async function fileToDataUrl(file: File, mimeType: string): Promise<string> {
    const buffer = new Uint8Array(await blobToArrayBuffer(file));
    const base64 = uint8ToBase64(buffer);
    return `data:${mimeType};base64,${base64}`;
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    const maybe = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
    if (typeof maybe.arrayBuffer === 'function') {
        return maybe.arrayBuffer();
    }
    if (typeof FileReader !== 'undefined') {
        return new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
            reader.onload = () => {
                const result = reader.result;
                if (result instanceof ArrayBuffer) {
                    resolve(result);
                } else {
                    reject(new Error('Unexpected FileReader result type'));
                }
            };
            reader.readAsArrayBuffer(blob);
        });
    }
    throw new Error('No mechanism available to read Blob into ArrayBuffer.');
}

export function getRawPcmDefaults(): { sampleRate: number; channels: number; bitDepth: number } {
    return {
        sampleRate: RAW_PCM_SAMPLE_RATE,
        channels: RAW_PCM_CHANNELS,
        bitDepth: RAW_PCM_BIT_DEPTH
    };
}

export async function getRawPcmAudioMetadata(file: File): Promise<AudioMetadata> {
    const { sampleRate, channels, bitDepth } = getRawPcmDefaults();
    const bytesPerSample = bitDepth / 8;
    const totalSamples = file.size / (bytesPerSample * channels);
    const duration = totalSamples / sampleRate;
    return {
        sampleRate,
        channels,
        bitDepth,
        duration,
        format: 'PCM (s16le)',
        fileSize: formatFileSize(file.size)
    };
}

export async function getAudioMetadata(file: File): Promise<AudioMetadata> {
    const ext = extOf(file.name);
    if (ext === RAW_PCM_EXTENSION) {
        return getRawPcmAudioMetadata(file);
    }
    return {
        fileSize: formatFileSize(file.size)
    };
}

function uint8ToBase64(bytes: Uint8Array): string {
    if (typeof btoa !== 'function') {
        // Fallback for environments lacking btoa (jsdom always has it; node test env may not).
        // Use a manual base64 encoder.
        const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let output = '';
        let i = 0;
        while (i < bytes.length) {
            const b1 = bytes[i++] ?? 0;
            const b2 = bytes[i++] ?? 0;
            const b3 = bytes[i++] ?? 0;
            output += table[b1 >> 2];
            output += table[((b1 & 0x03) << 4) | (b2 >> 4)];
            output += i - 1 > bytes.length ? '=' : table[((b2 & 0x0F) << 2) | (b3 >> 6)];
            output += i > bytes.length ? '=' : table[b3 & 0x3F];
        }
        return output;
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
