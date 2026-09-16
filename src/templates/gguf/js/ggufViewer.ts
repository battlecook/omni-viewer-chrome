// GGUF viewer entry — Chrome adapter over omni-viewer-core.
import {
    mountGgufViewer as mountCoreGgufViewer,
    type GgufViewerContext
} from 'omni-viewer-core/viewers/gguf';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type GgufViewerHandle = ViewerHandle;

function context(): GgufViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n
        : undefined;
    const ctx: GgufViewerContext = {
        assets: {
            resolveAssetUrl: async (path) =>
                typeof chrome !== 'undefined' && chrome.runtime?.getURL
                    ? chrome.runtime.getURL(path)
                    : path
        },
        i18n: {
            t: (key, args) =>
                chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) ||
                resolveCatalogMessage(key, args)
        },
        logger: {
            log: (level, message) =>
                console[level === 'info' ? 'info' : level]('[omni-viewer gguf]', message)
        }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    return ctx;
}

/**
 * Parse the selected browser File from its bytes. The core URI path speaks a
 * strict HTTP range protocol (206 plus a validated Content-Range) that a
 * `blob:` URL cannot satisfy, so a local File must take the byte path.
 */
export async function mountGgufViewer(
    file: File,
    container: HTMLElement
): Promise<GgufViewerHandle> {
    return mountCoreGgufViewer(
        {
            fileName: file.name,
            data: new Uint8Array(await file.arrayBuffer()),
            lastModified: file.lastModified
        },
        container,
        context()
    );
}

function createGgufProvider(): ChromeViewerProvider {
    let handle: GgufViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountGgufViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

const registration = VIEWER_REGISTRATIONS.find(
    (item) => item.viewType === 'omni-viewer.ggufViewer'
);
if (registration) registration.createProvider = createGgufProvider;

declare global {
    interface Window {
        __omniMountGguf?: typeof mountGgufViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountGguf = mountGgufViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="gguf"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'model.gguf');
        await mountGgufViewer(
            new File([blob], name, { type: blob.type || 'application/octet-stream' }),
            host
        );
    } catch (error) {
        host.textContent = `Failed to load GGUF data: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="gguf"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
