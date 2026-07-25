// TOML viewer entry (issue #65).
//
// This is the Chrome-side port of the VSCode `tomlViewer.js`. It is the
// webpack-resolved entry for `templates/toml/tomlViewer.js`. Two routes load
// it:
//
//   1. The standalone per-viewer page (`templates/toml/tomlViewer.html`)
//      — useful for "Load unpacked" + manual debugging in chrome://extensions.
//      Self-bootstrap reads the `?src=` blob URL and reconstructs a File.
//
//   2. The registry-driven router (`viewerRegistry.ts` -> the toml entry's
//      `createProvider`). Production traffic flows through here. The provider
//      calls `mountTomlViewer(file, container)` directly. We mirror the CSV
//      pattern of also exposing `window.__omniMountToml` so other harnesses
//      (e.g. integration test pages) can call into the bundle without
//      re-importing it.

import { mountTomlViewer as mountCoreTomlViewer } from 'omni-viewer-core/viewers/toml';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { createChromeFileSaveService } from '../../../utils/chromeFileSaveService';

export type TomlViewerHandle = ViewerHandle;

function context() {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage ? chrome.i18n : undefined;
    const ctx = {
        assets: { resolveAssetUrl: async (path: string) => typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key: string, args?: Record<string, string | number>) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level: 'info' | 'warn' | 'error', message: string) => console[level === 'info' ? 'info' : level]('[omni-viewer toml]', message) }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) Object.assign(ctx, { clipboard: { writeText: (text: string) => navigator.clipboard.writeText(text) } });
    const save = createChromeFileSaveService();
    if (save) Object.assign(ctx, { save });
    return ctx;
}

export async function mountTomlViewer(file: File, container: HTMLElement): Promise<TomlViewerHandle> {
    // Keep the Source pane as the stable viewport. Tree expand/collapse then
    // scrolls inside the right pane instead of resizing both panes.
    container.style.height = 'min(78vh, 900px)';
    container.style.minHeight = '560px';
    return mountCoreTomlViewer({ fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified }, container, context());
}

declare global {
    interface Window {
        __omniMountToml?: typeof mountTomlViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountToml = mountTomlViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="toml"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="toml"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        // Leave the static skeleton in place when no file is present.
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'data.toml');
        const file = new File([blob], name, {
            type: blob.type || 'application/toml'
        });
        await mountTomlViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load TOML: ${message}`;
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
