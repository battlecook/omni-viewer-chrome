// HAR (.har) network log viewer entry — Chrome adapter over omni-viewer-core.
import {
    mountHarViewer as mountCoreHarViewer,
    type HarViewerContext
} from 'omni-viewer-core/viewers/har';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type HarViewerHandle = ViewerHandle;

function context(): HarViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n
        : undefined;
    const locale = (typeof document !== 'undefined' ? document.documentElement.lang : '')
        || chromeI18n?.getUILanguage?.()
        || (typeof navigator !== 'undefined' ? navigator.language : '')
        || 'en';
    const ctx: HarViewerContext = {
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
                console[level === 'info' ? 'info' : level]('[omni-viewer har]', message)
        }
    };
    // The request list and body panes offer copy actions. The core renders
    // those buttons disabled with a `common.noClipboard` tooltip when the
    // service is absent; an extension page always has `navigator.clipboard`,
    // so the guard is only for a non-secure-context host.
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    return ctx;
}

/**
 * A HAR archive is JSON, so the core reads it with its own JSON parser
 * (`parseHar`) and renders the failure-analysis view: a filterable request
 * table with per-request waterfall bars, plus a detail pane for headers,
 * payload, response body, cookies and the timing breakdown.
 */
export async function mountHarViewer(
    file: File,
    container: HTMLElement,
    _fileHandle?: unknown,
    signal?: AbortSignal
): Promise<HarViewerHandle> {
    // The SPA panel and the standalone shell are both content-sized, and the
    // core's layout is `height: 100%` over `overflow: auto` panes — with no
    // bound it resolves to `auto`, so nothing scrolls internally. Measured on
    // a 600-entry archive: the panel grows to ~25,000 px, the toolbar leaves
    // the viewport, and the detail pane renders at the top of that stretched
    // grid row, thousands of pixels above the row just clicked. Same remedy
    // as the json/toml/pdf adapters.
    container.style.height = 'min(78vh, 900px)';
    container.style.minHeight = '560px';
    return mountCoreHarViewer(
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

function createHarProvider(): ChromeViewerProvider {
    let handle: HarViewerHandle | undefined;
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
            let nextHandle: HarViewerHandle;
            try {
                nextHandle = await mountHarViewer(
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
    (item) => item.viewType === 'omni-viewer.harViewer'
);
if (registration) registration.createProvider = createHarProvider;

declare global {
    interface Window {
        __omniMountHar?: typeof mountHarViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountHar = mountHarViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="har"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        // A `data:` URL has no path to take a name from, and its payload
        // would make `decodeURIComponent` throw — the same branch markdown,
        // latex and notebook take. `URLSearchParams` has already decoded the
        // query once, so a singly-encoded src (a URL pasted from the address
        // bar) can leave a literal `%` in the segment and throw there too;
        // the name only labels the viewer header, so fall back to the raw
        // segment rather than failing a load whose bytes already arrived.
        const name = src.startsWith('data:')
            ? 'network.har'
            : decodeSegment(src.split('/').pop() || 'network.har');
        await mountHarViewer(
            new File([blob], name, { type: blob.type || 'application/json' }),
            host
        );
    } catch (error) {
        host.textContent = `Failed to load HAR data: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="har"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `decodeURIComponent` that keeps the raw text when it is not valid escaping. */
function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}
