// Webpack entry for the archive viewer.
//
// Mirrors the wiring used by `templates/image/js/imageViewer.ts`:
//   1. Re-export the public `mountArchiveViewer` so direct imports work.
//   2. Side-effect on module load: patch the registry entry for
//      `omni-viewer.archiveViewer` so the router constructs a real provider
//      backed by `mountArchiveViewer` instead of the placeholder.
//   3. Self-bootstrap when the per-viewer HTML shell
//      (`src/templates/archive/archiveViewer.html`) is loaded directly with
//      a `?src=<blob-url>` query — this is the manual debug entrypoint
//      under `chrome://extensions` "Load unpacked".

import { mountArchiveViewer, ArchiveViewerHandle } from './archiveViewerMain';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export { mountArchiveViewer };
export type { ArchiveViewerHandle };

function createArchiveProvider(): ChromeViewerProvider {
    let handle: ArchiveViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountArchiveViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        },
    };
}

function installArchiveProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.archiveViewer'
    );
    if (!entry) return;
    entry.createProvider = createArchiveProvider;
}

installArchiveProvider();

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="archive"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="archive"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        host.textContent = 'No archive source provided.';
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'archive');
        const file = new File([blob], name, { type: blob.type });
        mountArchiveViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load archive: ${message}`;
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
