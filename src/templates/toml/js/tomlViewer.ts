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

import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { mountTomlViewer, TomlViewerHandle } from './tomlViewerMain';

export { mountTomlViewer };
export type { TomlViewerHandle };

const TARGET_VIEW_TYPE = 'omni-viewer.tomlViewer';
const registration = VIEWER_REGISTRATIONS.find((r) => r.viewType === TARGET_VIEW_TYPE);
if (registration) {
    registration.createProvider = (): ChromeViewerProvider => ({
        async render(file: File, container: HTMLElement): Promise<void> {
            await mountTomlViewer(file, container);
        }
    });
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
