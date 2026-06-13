// Webpack entry for the JSONL viewer (issue #59 — Hover popup).
//
// Mirrors the pattern documented in `src/templates/json/js/jsonViewer.ts`:
//
//   1. Re-export the public surface (`mountJsonlViewer`).
//   2. As a side effect at module load, mutate the matching entry in
//      `VIEWER_REGISTRATIONS` so the router constructs a real provider
//      instead of the placeholder. This is the agreed self-register
//      pattern that keeps the change scoped to `src/templates/jsonl/**`.
//   3. Self-bootstrap when loaded directly by the per-viewer HTML shell
//      (`src/templates/jsonl/jsonlViewer.html`) for manual debugging via
//      "Load unpacked" + chrome://extensions.

import { mountJsonlViewer, JsonlViewerHandle } from './jsonlViewerMain';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export { mountJsonlViewer };
export type { JsonlViewerHandle };

// --- Provider wiring (side effect on module load) -----------------------

function createJsonlProvider(): ChromeViewerProvider {
    let handle: JsonlViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountJsonlViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

function installJsonlProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.jsonlViewer'
    );
    if (!entry) return;
    entry.createProvider = createJsonlProvider;
}

installJsonlProvider();

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

declare global {
    interface Window {
        __omniMountJsonl?: typeof mountJsonlViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountJsonl = mountJsonlViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="jsonl"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="jsonl"]');
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
        const name = decodeURIComponent(src.split('/').pop() || 'data.jsonl');
        const file = new File([blob], name, { type: blob.type || 'application/x-ndjson' });
        await mountJsonlViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load JSONL: ${message}`;
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
