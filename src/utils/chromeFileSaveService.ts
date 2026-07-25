import type { FileSaveService } from 'omni-viewer-core/host';

const ANCHOR_DOWNLOAD_URL_LIFETIME_MS = 1_000;

/**
 * Chrome cannot write back to the File object handed to a viewer. Expose the
 * core FileSaveService contract as a normal browser download. Using an anchor
 * keeps Save/Export user-initiated and avoids the broad `downloads` permission.
 */
export function createChromeFileSaveService(): FileSaveService | undefined {
    if (
        typeof document === 'undefined'
        || typeof URL === 'undefined'
        || typeof URL.createObjectURL !== 'function'
    ) {
        return undefined;
    }

    return {
        async saveFile(name: string, data: Uint8Array, mimeType: string): Promise<void> {
            const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mimeType }));

            try {
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = name;
                anchor.style.display = 'none';
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
            } finally {
                setTimeout(() => URL.revokeObjectURL(url), ANCHOR_DOWNLOAD_URL_LIFETIME_MS);
            }
        }
    };
}
