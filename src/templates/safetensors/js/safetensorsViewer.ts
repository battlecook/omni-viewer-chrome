// Safetensors viewer entry — Chrome adapter over omni-viewer-core.
import {
    createSafetensorsBlobSource,
    mountSafetensorsViewer as mountCoreSafetensorsViewer,
    type SafetensorsViewerContext,
    type SafetensorsViewerSource
} from 'omni-viewer-core/viewers/safetensors';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type SafetensorsViewerHandle = ViewerHandle;

function context(): SafetensorsViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n
        : undefined;
    const locale = (typeof document !== 'undefined' ? document.documentElement.lang : '')
        || chromeI18n?.getUILanguage?.()
        || (typeof navigator !== 'undefined' ? navigator.language : '')
        || 'en';
    const ctx: SafetensorsViewerContext = {
        assets: {
            resolveAssetUrl: async (path) =>
                typeof chrome !== 'undefined' && chrome.runtime?.getURL
                    ? chrome.runtime.getURL(path)
                    : path
        },
        i18n: {
            t: (key, args) =>
                chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) ||
                resolveLocalizedCatalogMessage(locale, key, args)
        },
        logger: {
            log: (level, message) =>
                console[level === 'info' ? 'info' : level]('[omni-viewer safetensors]', message)
        }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    return ctx;
}

/**
 * Everything the viewer shows lives in the JSON header at the front of the
 * file, so the model is handed to the core as a lazy `Blob.slice()` source
 * rather than as bytes: only the 8-byte length prefix plus the header itself
 * is ever read. Tensor payloads — the whole reason these files run to many
 * gigabytes — stay on disk.
 */
export async function mountSafetensorsViewer(
    file: File,
    container: HTMLElement,
    _fileHandle?: unknown,
    signal?: AbortSignal
): Promise<SafetensorsViewerHandle> {
    const source: SafetensorsViewerSource = {
        ...createSafetensorsBlobSource(file, file.name),
        lastModified: file.lastModified
    };
    return mountCoreSafetensorsViewer(source, container, context(), { signal });
}

function createSafetensorsProvider(): ChromeViewerProvider {
    let handle: SafetensorsViewerHandle | undefined;
    let controller: AbortController | undefined;
    let generation = 0;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            const renderGeneration = ++generation;
            controller?.abort();
            handle?.dispose();
            handle = undefined;
            const renderController = new AbortController();
            controller = renderController;
            let nextHandle: SafetensorsViewerHandle;
            try {
                nextHandle = await mountSafetensorsViewer(
                    file,
                    container,
                    undefined,
                    renderController.signal
                );
            } catch (error) {
                if (renderGeneration !== generation || renderController.signal.aborted) return;
                throw error;
            }
            if (renderGeneration !== generation || renderController.signal.aborted) {
                nextHandle.dispose();
                return;
            }
            handle = nextHandle;
        },
        dispose(): void {
            generation += 1;
            controller?.abort();
            controller = undefined;
            handle?.dispose();
            handle = undefined;
        }
    };
}

const registration = VIEWER_REGISTRATIONS.find(
    (item) => item.viewType === 'omni-viewer.safetensorsViewer'
);
if (registration) registration.createProvider = createSafetensorsProvider;

declare global {
    interface Window {
        __omniMountSafetensors?: typeof mountSafetensorsViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountSafetensors = mountSafetensorsViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="safetensors"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'model.safetensors');
        await mountSafetensorsViewer(
            new File([blob], name, { type: blob.type || 'application/octet-stream' }),
            host
        );
    } catch (error) {
        host.textContent = `Failed to load safetensors data: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="safetensors"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
