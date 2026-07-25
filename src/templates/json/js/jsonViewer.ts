// Webpack entry for the JSON viewer (issue #62).
//
// Mirrors the pattern documented in `src/templates/image/js/imageViewer.ts`:
//
//   1. Re-export the public surface (`mountJsonViewer`).
//   2. As a side effect at module load, mutate the matching entry in
//      `VIEWER_REGISTRATIONS` so the router constructs a real provider
//      instead of the placeholder. This is the agreed self-register
//      pattern that keeps the change scoped to `src/templates/json/**`.
//   3. Self-bootstrap when loaded directly by the per-viewer HTML shell
//      (`src/templates/json/jsonViewer.html`) for manual debugging via
//      "Load unpacked" + chrome://extensions.

import { mountJsonViewer as mountCoreJsonViewer } from 'omni-viewer-core/viewers/json';
import type { JsonViewerContext } from 'omni-viewer-core/viewers/json';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { createChromeFileSaveService } from '../../../utils/chromeFileSaveService';

export interface JsonViewerHandle { dispose(): void; }

function context(): JsonViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n : undefined;
    const ctx: JsonViewerContext = {
        assets: { resolveAssetUrl: async (path) =>
            typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer json]', message) }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    ctx.save = createChromeFileSaveService();
    return ctx;
}

export async function mountJsonViewer(file: File, container: HTMLElement): Promise<JsonViewerHandle> {
    // The SPA panel is content-sized by default; establish the viewer viewport
    // so the core's tree/source panes can manage their own scrolling.
    container.style.height = 'min(78vh, 900px)';
    container.style.minHeight = '560px';
    return mountCoreJsonViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context()
    );
}

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

declare global {
    interface Window {
        __omniMountJson?: typeof mountJsonViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountJson = mountJsonViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="json"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="json"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        // Leave the static skeleton in place when no file is supplied.
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'data.json');
        const file = new File([blob], name, { type: blob.type || 'application/json' });
        await mountJsonViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load JSON: ${message}`;
    }
}

if (isSelfBootstrap()) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            void selfBootstrap();
        });
    } else {
        void selfBootstrap();
    }
}
