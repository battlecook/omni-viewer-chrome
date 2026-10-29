import type { ClipboardService, FileSaveService, HostContext } from 'omni-viewer-core/host';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import type { MountOptions, ViewerHandle, ViewerInput } from 'omni-viewer-core/viewers/types';
import { getRegistrationBySlug, type ViewerSlug } from '../viewerRegistry';
import { createChromeFileSaveService } from './chromeFileSaveService';

type ChromeCoreContext = HostContext & { clipboard?: ClipboardService; save?: FileSaveService };
type CoreMount = (
    input: ViewerInput, container: HTMLElement, context: ChromeCoreContext, options: MountOptions
) => Promise<ViewerHandle>;

function createContext(slug: string): ChromeCoreContext {
    const chromeI18n = typeof chrome !== 'undefined' ? chrome.i18n : undefined;
    const locale = document.documentElement.lang || chromeI18n?.getUILanguage?.()
        || navigator.language || 'en';
    return {
        assets: {
            resolveAssetUrl: async (path) =>
                typeof chrome !== 'undefined' && chrome.runtime?.getURL
                    ? chrome.runtime.getURL(path) : path
        },
        i18n: {
            t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_'))
                || resolveLocalizedCatalogMessage(locale, key, args)
        },
        logger: { log: (level, message) => console[level](`[omni-viewer ${slug}]`, message) },
        clipboard: navigator.clipboard
            ? { writeText: (text) => navigator.clipboard.writeText(text) } : undefined,
        save: createChromeFileSaveService()
    };
}

/** Adapt a core mount to the SPA, registry provider, and standalone page. */
export function createChromeCoreViewerMount(slug: ViewerSlug, coreMount: CoreMount) {
    async function mount(file: File, container: HTMLElement, _fileHandle?: unknown, signal?: AbortSignal): Promise<ViewerHandle> {
        container.style.height = 'min(78vh, 900px)';
        container.style.minHeight = '560px';
        return coreMount({
            fileName: file.name,
            data: new Uint8Array(await file.arrayBuffer()),
            lastModified: file.lastModified
        }, container, createContext(slug), { signal });
    }

    const registration = getRegistrationBySlug(slug);
    if (registration) registration.createProvider = () => {
        let controller: AbortController | undefined;
        let handle: ViewerHandle | undefined;
        let host: HTMLElement | undefined;
        let generation = 0;
        const dispose = () => {
            generation++;
            controller?.abort();
            controller = undefined;
            handle?.dispose();
            handle = undefined;
            host?.remove();
            host = undefined;
        };
        return {
            async render(file, container) {
                dispose();
                const current = generation;
                const nextController = new AbortController();
                controller = nextController;
                // Isolate each render so late cleanup cannot clear a newer viewer.
                const nextHost = document.createElement('div');
                host = nextHost;
                container.replaceChildren(nextHost);
                try {
                    const nextHandle = await mount(file, nextHost, undefined, nextController.signal);
                    if (current !== generation || nextController.signal.aborted) {
                        nextHandle.dispose();
                        nextHost.remove();
                    } else handle = nextHandle;
                } catch (error) {
                    nextHost.remove();
                    if (current !== generation || nextController.signal.aborted) return;
                    throw error;
                }
            },
            dispose
        };
    };

    async function selfBootstrap(): Promise<void> {
        const host = document.querySelector<HTMLElement>(`[data-viewer="${slug}"]`);
        const src = new URLSearchParams(window.location.search).get('src');
        if (!host || !src) return;
        try {
            const response = await fetch(src);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const url = new URL(src, window.location.href);
            let name = url.protocol === 'data:' || url.protocol === 'blob:'
                ? `document.${slug}` : url.pathname.split('/').pop() || `document.${slug}`;
            try { name = decodeURIComponent(name); } catch { /* Keep a malformed display name. */ }
            await mount(new File([blob], name, { type: blob.type }), host);
        } catch (error) {
            host.textContent = `Failed to load ${slug}: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
    if (typeof document !== 'undefined' && document.querySelector(`[data-viewer="${slug}"]`)) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => void selfBootstrap(), { once: true });
        } else void selfBootstrap();
    }
    return mount;
}
