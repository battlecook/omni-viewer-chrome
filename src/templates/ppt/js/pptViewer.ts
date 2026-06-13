// Webpack entry for the Chrome PPT viewer (issue #46).
//
// Same three responsibilities as `wordViewer.ts` / `excelViewer.ts`:
//   1. Re-export `mountPptViewer` so callers that import the bundled
//      chunk get a stable API.
//   2. Self-register as a side effect on module load by replacing the
//      placeholder `createProvider` in `VIEWER_REGISTRATIONS` for
//      `omni-viewer.pptViewer`.
//   3. Self-bootstrap when this script is loaded directly by the
//      per-viewer page shell (`src/templates/ppt/pptViewer.html`).

import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { mountPptViewer, PptViewerHandle } from './pptViewerMain';

export { mountPptViewer };
export type { PptViewerHandle };

// --- Provider wiring (side effect on module load) ---------------------

function createPptProvider(): ChromeViewerProvider {
    let handle: PptViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountPptViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

function installPptProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.pptViewer'
    );
    if (!entry) {
        // Registry shape is fixed at compile time; this branch only fires
        // if something deeply weird has happened to the bundle.
        return;
    }
    entry.createProvider = createPptProvider;
}

installPptProvider();

// --- Self-bootstrap for the per-viewer HTML shell ---------------------

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="ppt"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="ppt"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        host.textContent = 'No PowerPoint source provided.';
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'presentation.pptx');
        const file = new File([blob], name, {
            type:
                blob.type ||
                'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        });
        mountPptViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load PowerPoint document: ${message}`;
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
