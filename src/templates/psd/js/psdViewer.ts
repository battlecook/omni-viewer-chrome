// Webpack entry for the PSD viewer (issue #50).
//
// Three responsibilities, mirroring the PDF / image entries:
//
//   1. Re-export the public surface (`mountPsdViewer`) so callers that
//      import the bundled chunk get a stable API.
//
//   2. Wire the implementation into the registry as a SIDE EFFECT at
//      module load time. The registry (`src/viewerRegistry.ts`) ships a
//      placeholder `createPlaceholderProvider('omni-viewer.psdViewer')`
//      because per-viewer code lands in dedicated issues. We override
//      that placeholder by replacing the registration's `createProvider`
//      with one that returns a real provider built around
//      `mountPsdViewer`. This keeps the change scoped to
//      `src/templates/psd/**` per #50 guardrails — no edits to
//      `src/viewerRegistry.ts` or `src/router.ts`.
//
//   3. Self-bootstrap when this script is loaded directly by the
//      per-viewer page shell (`src/templates/psd/psdViewer.html`).
//      That shell is the manual-debug entry point: the script reads a
//      `?src=<blob-url>` query param and mounts the viewer into the
//      `data-viewer="psd"` host element.

import { mountPsdViewer, PsdViewerHandle } from './psdViewerMain';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export { mountPsdViewer };
export type { PsdViewerHandle };

// --- Provider wiring (side effect on module load) -----------------------

function createPsdProvider(): ChromeViewerProvider {
    let handle: PsdViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountPsdViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

function installPsdProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.psdViewer'
    );
    if (!entry) {
        // The registry shape is fixed at compile time; this branch only
        // fires if something deeply weird has happened to the bundle.
        return;
    }
    entry.createProvider = createPsdProvider;
}

installPsdProvider();

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="psd"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="psd"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        host.textContent = 'No PSD source provided.';
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'document.psd');
        const file = new File([blob], name, {
            type: blob.type || 'image/vnd.adobe.photoshop'
        });
        mountPsdViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load PSD: ${message}`;
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
