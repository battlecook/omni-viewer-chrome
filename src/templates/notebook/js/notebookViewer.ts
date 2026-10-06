// Jupyter Notebook (.ipynb) viewer entry — Chrome adapter over omni-viewer-core.
//
// The core viewer is a *read-only* preview: it never starts a kernel and never
// re-runs a cell. Code is rendered as highlighted text and every output is the
// one that was saved in the file, under a permanent "saved results" note. That
// is the specified behaviour, not a gap the adapter should paper over.
import {
    mountNotebookViewer as mountCoreNotebookViewer,
    type NotebookMountOptions,
    type NotebookViewerContext
} from 'omni-viewer-core/viewers/notebook';
import { loadNotebookViewerDeps } from 'omni-viewer-core/viewers/notebook/self-loading';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import { installKatexStyles } from '../../../utils/katexAssets';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type NotebookViewerHandle = ViewerHandle;

function context(): NotebookViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n
        : undefined;
    const locale = (typeof document !== 'undefined' ? document.documentElement.lang : '')
        || chromeI18n?.getUILanguage?.()
        || (typeof navigator !== 'undefined' ? navigator.language : '')
        || 'en';
    const ctx: NotebookViewerContext = {
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
                console[level === 'info' ? 'info' : level]('[omni-viewer notebook]', message)
        }
    };
    // Markdown cells and HTML outputs carry links; without a navigation
    // service the core marks them aria-disabled instead of opening them.
    ctx.navigation = {
        openExternalUrl: async (url) => { window.open(url, '_blank', 'noopener,noreferrer'); }
    };
    // `documentAssets` stays unwired: it resolves *relative* image paths
    // (`![](figures/plot.png)`) against the notebook's own directory, and the
    // page has no directory to resolve against. The SPA does keep whatever
    // else the user selected or dropped as a flat companion list (`app.js`
    // `state.companions`, which the OpenVINO viewer uses for its `.bin`
    // sidecar), but a flat list of names cannot answer a path. Those images
    // render as "Image unavailable"; inline base64 outputs and `attachment:`
    // images — how a notebook normally carries its figures — are read
    // straight out of the file and are unaffected.
    return ctx;
}

/**
 * Renderers are injected as the mount's fourth argument, the way the Markdown
 * viewer takes them: a notebook's Markdown cells and HTML outputs go through
 * marked + DOMPurify, so `render` and `createDOMPurify` are required rather
 * than optional. `loadNotebookViewerDeps()` adds highlight.js and KaTeX when
 * they resolve — the same optional peers as Markdown, minus the diagram
 * engines, which a notebook never needs.
 */
export async function mountNotebookViewer(
    file: File,
    container: HTMLElement,
    _fileHandle?: unknown,
    signal?: AbortSignal
): Promise<NotebookViewerHandle> {
    // The SPA panel (`.viewer-body`, padding only) and the standalone shell are
    // both content-sized, and the core's notebook layout is `height: 100%` with
    // the cell list as the one `overflow: auto` pane. With no bound that height
    // resolves to `auto`: the panel grows to the full cell list, the header,
    // search box and show-code toggles leave the viewport, and the internal
    // scroller never engages. Same remedy and the same numbers as the
    // json/toml/pdf/har adapters.
    container.style.height = 'min(78vh, 900px)';
    container.style.minHeight = '560px';
    const options: NotebookMountOptions = { ...(signal ? { signal } : {}) };
    const handle = await mountCoreNotebookViewer(
        {
            fileName: file.name,
            data: new Uint8Array(await file.arrayBuffer()),
            lastModified: file.lastModified
        },
        container,
        context(),
        await loadNotebookViewerDeps(),
        options
    );
    // The core injects its own stylesheet into the shadow root but never
    // katex.css — `$…$` in a Markdown cell and a `text/latex` output both
    // depend on it for layout, and its @font-face rules have to live in the
    // outer document (see utils/katexAssets.ts).
    installKatexStyles(container);
    return handle;
}

function createNotebookProvider(): ChromeViewerProvider {
    let handle: NotebookViewerHandle | undefined;
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
            let nextHandle: NotebookViewerHandle;
            try {
                nextHandle = await mountNotebookViewer(
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
    (item) => item.viewType === 'omni-viewer.notebookViewer'
);
if (registration) registration.createProvider = createNotebookProvider;

declare global {
    interface Window {
        __omniMountNotebook?: typeof mountNotebookViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountNotebook = mountNotebookViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="notebook"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        // A `data:` URL has no path to take a name from, and its payload would
        // make `decodeURIComponent` throw — the same branch markdown, latex and
        // har take. `URLSearchParams` has already decoded the query once, so a
        // singly-encoded src (a URL pasted from the address bar) can leave a
        // literal `%` in the segment and throw there too; the name only labels
        // the viewer header, so fall back to the raw segment rather than
        // failing a load whose bytes already arrived.
        const name = src.startsWith('data:')
            ? 'notebook.ipynb'
            : decodeSegment(src.split('/').pop() || 'notebook.ipynb');
        await mountNotebookViewer(
            new File([blob], name, { type: blob.type || 'application/x-ipynb+json' }),
            host
        );
    } catch (error) {
        host.textContent = `Failed to load notebook: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="notebook"]')) {
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
