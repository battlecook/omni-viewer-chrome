import { WebviewMessage } from './types';
import { createChromeFileSaveService } from '../chromeFileSaveService';

/**
 * Browser-only port of VSCode's MediaMessageHandlers.
 *
 * VSCode original wrote bytes to disk via `vscode.workspace.fs.writeFile`
 * and prompted with `showSaveDialog`. In a Chrome extension we can't write
 * arbitrary local files, so saving is implemented via the standard browser
 * download flow through the same permission-free `<a download>` service used
 * by the core viewer adapters.
 *
 * `documentUri` here is just the original file's URL/path string (or
 * undefined). It is kept as the second parameter to preserve the VSCode
 * call shape.
 */
export class MediaMessageHandlers {
    public static async handleSaveFilteredImage(message: WebviewMessage): Promise<void> {
        try {
            if (!message.fileName || !message.imageData) {
                throw new Error('No filename or image data provided');
            }

            const sanitized = this.sanitizeFileName(message.fileName);
            const mimeType = this.guessMimeFromFileName(sanitized) || 'image/png';
            const bytes = this.base64ToUint8Array(message.imageData);
            await this.triggerDownload(sanitized, bytes, mimeType);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            console.error('Error saving filtered image:', error);
            this.notifyError(`Failed to save filtered image: ${errorMessage}`);
        }
    }

    public static async handleSaveRegionFile(
        message: WebviewMessage,
        _documentUri?: string
    ): Promise<void> {
        try {
            if (!message.fileName || !message.blob) {
                throw new Error('No filename or blob data provided');
            }

            const sanitized = this.sanitizeFileName(message.fileName);
            const mimeType =
                message.mimeType || this.guessMimeFromFileName(sanitized) || 'application/octet-stream';
            const bytes = this.base64ToUint8Array(message.blob);
            await this.triggerDownload(sanitized, bytes, mimeType);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            console.error('Error saving region file:', error);
            this.notifyError(`Region 저장 실패: ${errorMessage}`);
        }
    }

    public static async handleDownloadFile(
        message: WebviewMessage,
        documentUri?: string
    ): Promise<void> {
        try {
            if (!documentUri) {
                throw new Error('No document URI available for download');
            }

            const fallbackName = this.basename(documentUri) || 'download';
            const fileName = this.sanitizeFileName(message.fileName || fallbackName);

            // Re-fetch the original asset and re-emit it as a download. Using
            // fetch keeps this code path browser-only and works for both
            // `chrome-extension://` resources and `blob:`/`https:` URLs.
            const response = await fetch(documentUri);
            if (!response.ok) {
                throw new Error(`Fetch failed with HTTP ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const mimeType =
                message.mimeType ||
                response.headers.get('content-type') ||
                this.guessMimeFromFileName(fileName) ||
                'application/octet-stream';
            await this.triggerDownload(fileName, new Uint8Array(arrayBuffer), mimeType);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            console.error('Error handling download request:', error);
            this.notifyError(`Download failed: ${errorMessage}`);
        }
    }

    /* ----------------------------- helpers ------------------------------ */

    public static sanitizeFileName(fileName: string): string {
        return fileName
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_{2,}/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 255);
    }

    public static base64ToUint8Array(base64: string): Uint8Array {
        if (typeof atob !== 'function') {
            throw new Error('atob is not available in the current runtime');
        }
        const binary = atob(base64);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            out[i] = binary.charCodeAt(i);
        }
        return out;
    }

    public static async triggerDownload(
        fileName: string,
        data: Uint8Array,
        mimeType: string
    ): Promise<void> {
        const save = createChromeFileSaveService();
        if (!save) throw new Error('No download mechanism available in this context');
        await save.saveFile(fileName, data, mimeType);
    }

    private static guessMimeFromFileName(fileName: string): string | null {
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const map: Record<string, string> = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
            bmp: 'image/bmp',
            wav: 'audio/wav',
            mp3: 'audio/mpeg',
            ogg: 'audio/ogg',
            flac: 'audio/flac',
            m4a: 'audio/mp4',
            aac: 'audio/aac',
            mp4: 'video/mp4',
            webm: 'video/webm',
            pdf: 'application/pdf'
        };
        return map[ext] || null;
    }

    private static basename(uri: string): string {
        const cleaned = uri.split('?')[0].split('#')[0];
        const parts = cleaned.split(/[\\/]/);
        return parts[parts.length - 1] || '';
    }

    private static notifyError(message: string): void {
        // Surface failures via the browser; viewer code may also listen to
        // `chrome.runtime` messages for richer UX, but a console + alert is
        // a safe default that doesn't depend on the host page.
        console.error(message);
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
            try {
                window.alert(message);
            } catch {
                /* ignored — alert may be blocked */
            }
        }
    }
}
