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

import { mountJsonViewer, JsonViewerHandle } from './jsonViewerMain';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export { mountJsonViewer };
export type { JsonViewerHandle };

// --- Provider wiring (side effect on module load) -----------------------

function createJsonProvider(): ChromeViewerProvider {
    let handle: JsonViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountJsonViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

function installJsonProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.jsonViewer'
    );
    if (!entry) return;
    entry.createProvider = createJsonProvider;
}

installJsonProvider();

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
