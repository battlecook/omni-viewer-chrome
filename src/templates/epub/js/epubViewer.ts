// EPUB (.epub, EPUB 2.0.1 and 3.x) e-book reader entry — Chrome adapter over
// omni-viewer-core.
import {
    mountEpubViewer as mountCoreEpubViewer,
    type EpubViewerContext,
    type EpubViewerHandle as CoreEpubViewerHandle
} from 'omni-viewer-core/viewers/epub';
import { loadEpubViewerDeps } from 'omni-viewer-core/viewers/epub/self-loading';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type EpubViewerHandle = CoreEpubViewerHandle;

function context(): EpubViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n
        : undefined;
    const locale = (typeof document !== 'undefined' ? document.documentElement.lang : '')
        || chromeI18n?.getUILanguage?.()
        || (typeof navigator !== 'undefined' ? navigator.language : '')
        || 'en';
    return {
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
                console[level === 'info' ? 'info' : level]('[omni-viewer epub]', message)
        },
        // Chapters carry external links; the core checks the scheme against
        // its allow-list before calling this, and without the service it
        // leaves those links inert.
        navigation: {
            openExternalUrl: async (url) => { window.open(url, '_blank', 'noopener,noreferrer'); }
        }
    };
}

/**
 * The core reads only the package files (container, OPF, nav/NCX, encryption)
 * up front and inflates chapters and images on demand through the platform's
 * `DecompressionStream('deflate-raw')`. Chapter markup is DOMPurify-sanitized
 * in an inert document, without publisher CSS, scripts, forms or remote
 * images, so the bundled `dompurify` is the reader's only dependency.
 */
export async function mountEpubViewer(
    file: File,
    container: HTMLElement,
    _fileHandle?: unknown,
    signal?: AbortSignal
): Promise<EpubViewerHandle> {
    // The reading pane and the table of contents scroll inside a
    // `height: 100%` layout, so the content-sized SPA panel has to bound it.
    // Same remedy as the har/json/toml adapters.
    container.style.height = 'min(82vh, 1000px)';
    container.style.minHeight = '560px';
    const deps = await loadEpubViewerDeps();
    return mountCoreEpubViewer(
        {
            fileName: file.name,
            data: new Uint8Array(await file.arrayBuffer()),
            lastModified: file.lastModified
        },
        container,
        context(),
        deps,
        { signal }
    );
}

function createEpubProvider(): ChromeViewerProvider {
    let handle: EpubViewerHandle | undefined;
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
            let nextHandle: EpubViewerHandle;
            try {
                nextHandle = await mountEpubViewer(
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
    (item) => item.viewType === 'omni-viewer.epubViewer'
);
if (registration) registration.createProvider = createEpubProvider;

declare global {
    interface Window {
        __omniMountEpub?: typeof mountEpubViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountEpub = mountEpubViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="epub"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'book.epub');
        await mountEpubViewer(
            new File([blob], name, { type: blob.type || 'application/epub+zip' }),
            host
        );
    } catch (error) {
        host.textContent = `Failed to load EPUB book: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="epub"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
