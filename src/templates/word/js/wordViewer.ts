// Webpack entry for the Chrome Word viewer (issue #43).
//
// Three responsibilities (parallel to `imageViewer.ts` / `pdfViewer.ts`
// / `excelViewer.ts`):
//
//   1. Re-export the public surface (`mountWordViewer`) so callers
//      that import the bundled chunk get a stable API.
//
//   2. Wire the implementation into the registry as a SIDE EFFECT at
//      module load time. The registry (`src/viewerRegistry.ts`) ships
//      a placeholder `createPlaceholderProvider('omni-viewer.wordViewer')`
//      because per-viewer code is built in dedicated issues. We
//      override that placeholder by replacing the registration's
//      `createProvider` with one that returns a real provider built
//      around `mountWordViewer`. Idempotent — re-loading the entry is
//      harmless.
//
//   3. Self-bootstrap when this script is loaded directly by the
//      per-viewer page shell (`src/templates/word/wordViewer.html`).
//      That shell is the manual-debug entry point: the script reads a
//      `?src=<blob-url>` query param and mounts the viewer into the
//      `data-viewer="word"` host element.

import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { mountWordViewer, WordViewerHandle } from './wordViewerMain';

export { mountWordViewer };
export type { WordViewerHandle };

// --- Provider wiring (side effect on module load) ---------------------

function createWordProvider(): ChromeViewerProvider {
    let handle: WordViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountWordViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

function installWordProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.wordViewer'
    );
    if (!entry) {
        // The registry shape is fixed at compile time; this branch only
        // fires if something deeply weird has happened to the bundle.
        return;
    }
    entry.createProvider = createWordProvider;
}

installWordProvider();

// --- Self-bootstrap for the per-viewer HTML shell ---------------------

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="word"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="word"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        host.textContent = 'No Word source provided.';
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'document.docx');
        const file = new File([blob], name, {
            type:
                blob.type ||
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });
        mountWordViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load Word document: ${message}`;
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
