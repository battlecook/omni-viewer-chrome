// ExecuTorch (.pte) viewer entry — Chrome adapter over omni-viewer-core.
import {
    mountPteViewer as mountCorePteViewer,
    type PteViewerContext
} from 'omni-viewer-core/viewers/pte';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type PteViewerHandle = ViewerHandle;

function context(): PteViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n
        : undefined;
    const locale = (typeof document !== 'undefined' ? document.documentElement.lang : '')
        || chromeI18n?.getUILanguage?.()
        || (typeof navigator !== 'undefined' ? navigator.language : '')
        || 'en';
    const ctx: PteViewerContext = {
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
                console[level === 'info' ? 'info' : level]('[omni-viewer pte]', message)
        }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    return ctx;
}

/**
 * The core parser reads the ExecuTorch `ET12` FlatBuffer directly — program
 * methods, instruction chains, delegates and segment table — without decoding
 * the constant or delegate payloads that trail the program.
 */
export async function mountPteViewer(
    file: File,
    container: HTMLElement,
    _fileHandle?: unknown,
    signal?: AbortSignal
): Promise<PteViewerHandle> {
    return mountCorePteViewer(
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

function createPteProvider(): ChromeViewerProvider {
    let handle: PteViewerHandle | undefined;
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
            let nextHandle: PteViewerHandle;
            try {
                nextHandle = await mountPteViewer(
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
    (item) => item.viewType === 'omni-viewer.pteViewer'
);
if (registration) registration.createProvider = createPteProvider;

declare global {
    interface Window {
        __omniMountPte?: typeof mountPteViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountPte = mountPteViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="pte"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'model.pte');
        await mountPteViewer(
            new File([blob], name, { type: blob.type || 'application/octet-stream' }),
            host
        );
    } catch (error) {
        host.textContent = `Failed to load ExecuTorch data: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="pte"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
