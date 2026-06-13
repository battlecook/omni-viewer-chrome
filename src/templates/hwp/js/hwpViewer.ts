// Webpack entry for the HWP viewer (issue #53).
//
// Three responsibilities (parallel to `pdfViewer.ts` / `psdViewer.ts`):
//
//   1. Re-export the public surface (`mountHwpViewer`) so callers that
//      import the bundled chunk get a stable API.
//
//   2. Wire the implementation into the registry as a SIDE EFFECT at
//      module load time. The registry (`src/viewerRegistry.ts`) ships a
//      placeholder `createPlaceholderProvider('omni-viewer.hwpViewer')`
//      because per-viewer code is built in dedicated issues. We override
//      that placeholder by replacing the registration's `createProvider`
//      with one that returns a real provider built around
//      `mountHwpViewer`. The override is idempotent so loading this
//      entry twice is harmless. This keeps the change scoped to
//      `src/templates/hwp/**` per #53 guardrails — no edits to
//      `src/viewerRegistry.ts` or `src/router.ts`.
//
//   3. Self-bootstrap when this script is loaded directly by the
//      per-viewer page shell (`src/templates/hwp/hwpViewer.html`).
//      That shell is the manual-debug entry point: the script reads
//      a `?src=<blob-url>` query param and mounts the viewer into the
//      `data-viewer="hwp"` host element.
//
// HWPX (zipped XML format) is intentionally NOT supported here — that's
// issue #54. Binary `.hwp` only.

import { mountHwpViewer, HwpViewerHandle } from './hwpViewerMain';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export { mountHwpViewer };
export type { HwpViewerHandle };

// --- Provider wiring (side effect on module load) -----------------------

function createHwpProvider(): ChromeViewerProvider {
    let handle: HwpViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountHwpViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        },
    };
}

function installHwpProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.hwpViewer'
    );
    if (!entry) {
        // The registry shape is fixed at compile time; this branch
        // only fires if something deeply weird has happened to the
        // bundle.
        return;
    }
    entry.createProvider = createHwpProvider;
}

installHwpProvider();

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="hwp"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="hwp"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        host.textContent = 'No HWP source provided.';
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'document.hwp');
        const file = new File([blob], name, {
            type: blob.type || 'application/octet-stream',
        });
        mountHwpViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load HWP: ${message}`;
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
