// Webpack entry for the YAML viewer (issue #64).
//
// Mirrors the JSON viewer entry (`templates/json/js/jsonViewer.ts`):
//
//   1. Re-export the public surface (`mountYamlViewer`).
//   2. As a side effect at module load, mutate the matching entry in
//      `VIEWER_REGISTRATIONS` so the router constructs a real provider
//      instead of the placeholder. This is the agreed self-register
//      pattern that keeps the change scoped to `src/templates/yaml/**`.
//   3. Self-bootstrap when loaded directly by the per-viewer HTML shell
//      (`src/templates/yaml/yamlViewer.html`) for manual debugging via
//      "Load unpacked" + chrome://extensions.

import { mountYamlViewer as mountCoreYamlViewer } from 'omni-viewer-core/viewers/yaml';
import { loadYamlParserDeps } from 'omni-viewer-core/parsers/yaml/self-loading';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { createChromeFileSaveService } from '../../../utils/chromeFileSaveService';

export type YamlViewerHandle = ViewerHandle;

function context() {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage ? chrome.i18n : undefined;
    const ctx = {
        assets: { resolveAssetUrl: async (path: string) => typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key: string, args?: Record<string, string | number>) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level: 'info' | 'warn' | 'error', message: string) => console[level === 'info' ? 'info' : level]('[omni-viewer yaml]', message) }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) Object.assign(ctx, { clipboard: { writeText: (text: string) => navigator.clipboard.writeText(text) } });
    const save = createChromeFileSaveService();
    if (save) Object.assign(ctx, { save });
    return ctx;
}

export async function mountYamlViewer(file: File, container: HTMLElement): Promise<YamlViewerHandle> {
    return mountCoreYamlViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context(),
        { deps: await loadYamlParserDeps() }
    );
}

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

declare global {
    interface Window {
        __omniMountYaml?: typeof mountYamlViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountYaml = mountYamlViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="yaml"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="yaml"]');
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
        const name = decodeURIComponent(src.split('/').pop() || 'data.yaml');
        const file = new File([blob], name, { type: blob.type || 'text/yaml' });
        await mountYamlViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load YAML: ${message}`;
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
