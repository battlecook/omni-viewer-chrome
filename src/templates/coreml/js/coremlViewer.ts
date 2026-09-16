// Core ML viewer entry — Chrome adapter over omni-viewer-core.
import {
    mountCoremlViewer as mountCoreCoremlViewer,
    type CoremlViewerContext
} from 'omni-viewer-core/viewers/coreml';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type CoremlViewerHandle = ViewerHandle;

function context(): CoremlViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n
        : undefined;
    const locale = (typeof document !== 'undefined' ? document.documentElement.lang : '')
        || chromeI18n?.getUILanguage?.()
        || (typeof navigator !== 'undefined' ? navigator.language : '')
        || 'en';
    const ctx: CoremlViewerContext = {
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
                console[level === 'info' ? 'info' : level]('[omni-viewer coreml]', message)
        }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    return ctx;
}

/**
 * Both Core ML encodings reach the same core reader: a bare `.mlmodel`
 * specification protobuf, and an `.mlpackage` bundle, which arrives here as
 * the ZIP a browser can actually hand over (a File is one file, never the
 * directory macOS shows). The core tells them apart by the ZIP header, so
 * neither the extension nor this adapter has to decide.
 *
 * Weight payloads are never decoded — blob references resolve to a file, an
 * offset, and a byte count — so handing over the whole buffer stays cheap
 * even for a multi-gigabyte model.
 */
export async function mountCoremlViewer(
    file: File,
    container: HTMLElement,
    _fileHandle?: unknown,
    signal?: AbortSignal
): Promise<CoremlViewerHandle> {
    return mountCoreCoremlViewer(
        {
            fileName: file.name,
            data: new Uint8Array(await file.arrayBuffer()),
            lastModified: file.lastModified
        },
        container,
        context(),
        { signal }
    );
}

function createCoremlProvider(): ChromeViewerProvider {
    let handle: CoremlViewerHandle | undefined;
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
            let nextHandle: CoremlViewerHandle;
            try {
                nextHandle = await mountCoremlViewer(
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
    (item) => item.viewType === 'omni-viewer.coremlViewer'
);
if (registration) registration.createProvider = createCoremlProvider;

declare global {
    interface Window {
        __omniMountCoreml?: typeof mountCoremlViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountCoreml = mountCoremlViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="coreml"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'model.mlmodel');
        await mountCoremlViewer(
            new File([blob], name, { type: blob.type || 'application/octet-stream' }),
            host
        );
    } catch (error) {
        host.textContent = `Failed to load Core ML data: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="coreml"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
