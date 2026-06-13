// Webpack entry for the image viewer.
//
// Webpack consumes this file as the entry for `templates/image` (see
// webpack.config.js), and outputs `dist/templates/image/imageViewer.js`.
//
// Three responsibilities:
//
//   1. Re-export the public surface (`mountImageViewer`) so callers that
//      import the bundled chunk get a stable API.
//
//   2. Wire the implementation into the registry as a SIDE EFFECT at
//      module load time. The registry (`src/viewerRegistry.ts`) ships a
//      placeholder `createPlaceholderProvider('omni-viewer.imageViewer')`
//      because the per-viewer code is built in a separate issue. We
//      override that placeholder by replacing the registration's
//      `createProvider` with one that returns a real provider built
//      around `mountImageViewer`. The registry array is exported and the
//      override is harmless if the entry is loaded twice (idempotent
//      property write). This keeps the change scoped to
//      `src/templates/image/**` per issue #9 guardrails — no edits to
//      `src/viewerRegistry.ts` or `src/router.ts`.
//
//   3. Self-bootstrap when this script is loaded directly by the
//      per-viewer page shell (`src/templates/image/imageViewer.html`).
//      That shell is the manual-debug entry point: the script reads a
//      `?src=<blob-url>` query param and mounts the viewer into the
//      `data-viewer="image"` host element. This is the dev affordance
//      noted in `src/router.ts` (manual navigation under
//      `chrome://extensions` "Load unpacked").

import { mountImageViewer, ImageViewerHandle } from './imageViewerMain';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export { mountImageViewer };
export type { ImageViewerHandle };

// --- Provider wiring (side effect on module load) -----------------------

/**
 * Build a `ChromeViewerProvider` that mounts the real image viewer and
 * forwards `dispose` so the router can revoke the blob URL when the
 * viewer is replaced.
 */
function createImageProvider(): ChromeViewerProvider {
    let handle: ImageViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountImageViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

/**
 * Patch the registry entry for `omni-viewer.imageViewer` so the router's
 * `mountViewerForFile` constructs the real provider instead of the
 * placeholder. Idempotent — safe to import multiple times.
 */
function installImageProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.imageViewer'
    );
    if (!entry) {
        // The registry shape is fixed at compile time; this branch only
        // fires if something deeply weird has happened to the bundle.
        return;
    }
    entry.createProvider = createImageProvider;
}

installImageProvider();

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="image"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="image"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        host.textContent = 'No image source provided.';
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'image');
        const file = new File([blob], name, { type: blob.type });
        mountImageViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load image: ${message}`;
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
