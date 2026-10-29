// HTML (.html, .htm) viewer entry — Chrome adapter over omni-viewer-core.
import {
    mountHtmlViewer as mountCoreHtmlViewer
} from 'omni-viewer-core/viewers/html';
import type { HostContext } from 'omni-viewer-core/host';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type HtmlViewerHandle = ViewerHandle;

function context(): HostContext {
    const chromeI18n = typeof chrome !== 'undefined'
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
                console[level === 'info' ? 'info' : level]('[omni-viewer html]', message)
        }
    };
}

/** The core owns HTML decoding, sandboxed preview, and source tabs. */
export async function mountHtmlViewer(
    file: File,
    container: HTMLElement,
    _fileHandle?: unknown,
    signal?: AbortSignal
): Promise<HtmlViewerHandle> {
    // Bound the flex layout so preview and source panes scroll inside it.
    container.style.height = 'min(78vh, 900px)';
    container.style.minHeight = '560px';
    return mountCoreHtmlViewer(
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

function createHtmlProvider(): ChromeViewerProvider {
    let handle: HtmlViewerHandle | undefined;
    let controller: AbortController | undefined;
    let mountContainer: HTMLElement | undefined;
    let generation = 0;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            const renderGeneration = ++generation;
            controller?.abort();
            handle?.dispose();
            handle = undefined;
            mountContainer?.remove();
            // A core handle clears its entire shadow root on disposal. Give
            // each render its own root so late cleanup cannot clear its successor.
            const renderContainer = document.createElement('div');
            mountContainer = renderContainer;
            container.replaceChildren(renderContainer);
            const renderController = new AbortController();
            controller = renderController;
            let nextHandle: HtmlViewerHandle;
            try {
                nextHandle = await mountHtmlViewer(
                    file,
                    renderContainer,
                    undefined,
                    renderController.signal
                );
            } catch (error) {
                renderContainer.remove();
                if (renderGeneration !== generation || renderController.signal.aborted) return;
                throw error;
            }
            if (renderGeneration !== generation || renderController.signal.aborted) {
                nextHandle.dispose();
                renderContainer.remove();
                return;
            }
            handle = {
                dispose(): void {
                    nextHandle.dispose();
                    renderContainer.remove();
                }
            };
        },
        dispose(): void {
            generation += 1;
            controller?.abort();
            controller = undefined;
            handle?.dispose();
            handle = undefined;
            mountContainer?.remove();
            mountContainer = undefined;
        }
    };
}

const registration = VIEWER_REGISTRATIONS.find(
    (item) => item.viewType === 'omni-viewer.htmlViewer'
);
if (registration) registration.createProvider = createHtmlProvider;

declare global {
    interface Window {
        __omniMountHtml?: typeof mountHtmlViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountHtml = mountHtmlViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="html"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const sourceUrl = new URL(src, window.location.href);
        const name = sourceUrl.protocol === 'data:' || sourceUrl.protocol === 'blob:'
            ? 'document.html'
            : decodeSegment(sourceUrl.pathname.split('/').pop() || 'document.html');
        await mountHtmlViewer(
            new File([blob], name, { type: blob.type || 'text/html' }),
            host
        );
    } catch (error) {
        host.textContent = `Failed to load HTML data: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="html"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        // Display-name decoding must not discard bytes already fetched.
        return segment;
    }
}
