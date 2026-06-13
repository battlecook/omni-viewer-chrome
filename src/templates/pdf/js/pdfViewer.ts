// Webpack entry for the PDF viewer (issue #16).
//
// Three responsibilities (parallel to `imageViewer.ts` from issue #9):
//
//   1. Re-export the public surface (`mountPdfViewer`) so callers that
//      import the bundled chunk get a stable API.
//
//   2. Wire the implementation into the registry as a SIDE EFFECT at
//      module load time. The registry (`src/viewerRegistry.ts`) ships a
//      placeholder `createPlaceholderProvider('omni-viewer.pdfViewer')`
//      because per-viewer code is built in dedicated issues. We override
//      that placeholder by replacing the registration's `createProvider`
//      with one that returns a real provider built around
//      `mountPdfViewer`. The registry array is exported and the override
//      is harmless if the entry is loaded twice (idempotent property
//      write). This keeps the change scoped to `src/templates/pdf/**`
//      per #16 guardrails — no edits to `src/viewerRegistry.ts` or
//      `src/router.ts`.
//
//   3. Self-bootstrap when this script is loaded directly by the
//      per-viewer page shell (`src/templates/pdf/pdfViewer.html`).
//      That shell is the manual-debug entry point: the script reads a
//      `?src=<blob-url>` query param and mounts the viewer into the
//      `data-viewer="pdf"` host element.

import { mountPdfViewer, PdfViewerHandle } from './pdfViewerMain';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export { mountPdfViewer };
export type { PdfViewerHandle };

// --- Provider wiring (side effect on module load) -----------------------

function createPdfProvider(): ChromeViewerProvider {
    let handle: PdfViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountPdfViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

function installPdfProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.pdfViewer'
    );
    if (!entry) {
        // The registry shape is fixed at compile time; this branch only
        // fires if something deeply weird has happened to the bundle.
        return;
    }
    entry.createProvider = createPdfProvider;
}

installPdfProvider();

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="pdf"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="pdf"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        host.textContent = 'No PDF source provided.';
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'document.pdf');
        const file = new File([blob], name, {
            type: blob.type || 'application/pdf'
        });
        mountPdfViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load PDF: ${message}`;
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
