// Word viewer entry — Chrome adapter over omni-viewer-core.
import {
    mountWordViewer as mountCoreWordViewer,
    type WordViewerContext,
    type WordViewerHandle
} from 'omni-viewer-core/viewers/word';
import { loadWordViewerDeps } from 'omni-viewer-core/viewers/word/self-loading';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';

function context(): WordViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n : undefined;
    return {
        assets: { resolveAssetUrl: async (path) =>
            typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer word]', message) },
        print: { print: () => window.print() }
    };
}

export async function mountWordViewer(file: File, container: HTMLElement): Promise<WordViewerHandle> {
    return mountCoreWordViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context(),
        await loadWordViewerDeps()
    );
}

declare global { interface Window { __omniMountWord?: typeof mountWordViewer; } }
if (typeof window !== 'undefined') window.__omniMountWord = mountWordViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="word"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'document.docx');
        await mountWordViewer(new File([blob], name, {
            type: blob.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        }), host);
    } catch (error) {
        host.textContent = `Failed to load Word document: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="word"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
