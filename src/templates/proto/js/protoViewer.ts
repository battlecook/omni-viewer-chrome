// Protocol Buffers viewer entry — Chrome adapter over omni-viewer-core.
import {
    mountProtoViewer as mountCoreProtoViewer,
    type ProtoViewerContext
} from 'omni-viewer-core/viewers/proto';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';

export type ProtoViewerHandle = ViewerHandle;

function context(): ProtoViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n : undefined;
    const ctx: ProtoViewerContext = {
        assets: { resolveAssetUrl: async (path) =>
            typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer proto]', message) }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    return ctx;
}

export async function mountProtoViewer(file: File, container: HTMLElement): Promise<ProtoViewerHandle> {
    return mountCoreProtoViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context()
    );
}

declare global { interface Window { __omniMountProto?: typeof mountProtoViewer; } }
if (typeof window !== 'undefined') window.__omniMountProto = mountProtoViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="proto"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'schema.proto');
        await mountProtoViewer(new File([blob], name, { type: blob.type || 'text/plain' }), host);
    } catch (error) {
        host.textContent = `Failed to load Proto: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="proto"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
