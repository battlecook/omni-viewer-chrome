// Generic XML (.xml, .xsd, .wsdl, .rss, .kml, …) viewer entry — Chrome adapter
// over omni-viewer-core.
import {
    mountXmlViewer as mountCoreXmlViewer,
    type XmlViewerContext
} from 'omni-viewer-core/viewers/xml';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type XmlViewerHandle = ViewerHandle;

function context(): XmlViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n
        : undefined;
    const locale = (typeof document !== 'undefined' ? document.documentElement.lang : '')
        || chromeI18n?.getUILanguage?.()
        || (typeof navigator !== 'undefined' ? navigator.language : '')
        || 'en';
    const ctx: XmlViewerContext = {
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
                console[level === 'info' ? 'info' : level]('[omni-viewer xml]', message)
        }
    };
    // XPath / value / XML copy. The core renders those buttons disabled when
    // the service is absent; the guard is only for a non-secure-context host.
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    return ctx;
}

/**
 * The core parser is a DOM-free, tolerant XML 1.0 scanner: it never reads
 * external entities, expands internal ones one level under a budget, and
 * recovers from well-formedness errors so a broken document still opens as a
 * tree. The viewer links a virtualized element tree to the source both ways.
 */
export async function mountXmlViewer(
    file: File,
    container: HTMLElement,
    _fileHandle?: unknown,
    signal?: AbortSignal
): Promise<XmlViewerHandle> {
    // The tree and source panes are virtualized inside a `height: 100%`
    // layout, so the content-sized SPA panel has to bound it or nothing
    // scrolls internally. Same remedy as the har/json/toml adapters.
    container.style.height = 'min(78vh, 900px)';
    container.style.minHeight = '560px';
    return mountCoreXmlViewer(
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

function createXmlProvider(): ChromeViewerProvider {
    let handle: XmlViewerHandle | undefined;
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
            let nextHandle: XmlViewerHandle;
            try {
                nextHandle = await mountXmlViewer(
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
    (item) => item.viewType === 'omni-viewer.xmlViewer'
);
if (registration) registration.createProvider = createXmlProvider;

declare global {
    interface Window {
        __omniMountXml?: typeof mountXmlViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountXml = mountXmlViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="xml"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'document.xml');
        await mountXmlViewer(
            new File([blob], name, { type: blob.type || 'application/xml' }),
            host
        );
    } catch (error) {
        host.textContent = `Failed to load XML data: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="xml"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
