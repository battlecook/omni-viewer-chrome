// Webpack entry for the Parquet viewer (issue #39).
//
// Three responsibilities (parallel to `pdfViewer.ts` / `psdViewer.ts` /
// `hwpViewer.ts`):
//
//   1. Re-export the public surface (`mountParquetViewer`) so callers
//      that import the bundled chunk get a stable API.
//
//   2. Wire the implementation into the registry as a SIDE EFFECT at
//      module load time. The registry (`src/viewerRegistry.ts`) ships a
//      placeholder `createPlaceholderProvider('omni-viewer.parquetViewer')`
//      because per-viewer code is built in dedicated issues. We override
//      that placeholder by replacing the registration's `createProvider`
//      with one that returns a real provider built around
//      `mountParquetViewer`. The override is idempotent so loading this
//      entry twice is harmless. This keeps the change scoped to
//      `src/templates/parquet/**` per #39 guardrails — no edits to
//      `src/viewerRegistry.ts` or `src/router.ts`.
//
//   3. Self-bootstrap when this script is loaded directly by the
//      per-viewer page shell (`src/templates/parquet/parquetViewer.html`).
//      That shell is the manual-debug entry point: the script reads a
//      `?src=<blob-url>` query param and mounts the viewer into the
//      `data-viewer="parquet"` host element.

import { mountParquetViewer, ParquetViewerHandle } from './parquetViewerMain';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export { mountParquetViewer };
export type { ParquetViewerHandle };

// --- Provider wiring (side effect on module load) -----------------------

function createParquetProvider(): ChromeViewerProvider {
    let handle: ParquetViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountParquetViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        },
    };
}

function installParquetProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.parquetViewer'
    );
    if (!entry) {
        // The registry shape is fixed at compile time; this branch only
        // fires if something deeply weird has happened to the bundle.
        return;
    }
    entry.createProvider = createParquetProvider;
}

installParquetProvider();

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="parquet"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="parquet"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        host.textContent = 'No Parquet source provided.';
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'data.parquet');
        const file = new File([blob], name, {
            type: blob.type || 'application/octet-stream',
        });
        mountParquetViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load Parquet: ${message}`;
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
