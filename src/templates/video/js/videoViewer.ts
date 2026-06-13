// Webpack entry for the video viewer (issue #28).
//
// Mirrors the image / csv / audio entry shape:
//
//   1. Re-export the public surface (`mountVideoViewer`) so callers that
//      import the bundled chunk get a stable API.
//
//   2. Wire the implementation into the registry as a SIDE EFFECT at module
//      load time. The registry (`src/viewerRegistry.ts`) ships a placeholder
//      `createPlaceholderProvider('omni-viewer.videoViewer')` because the
//      per-viewer code is built in this issue. We override that placeholder
//      by replacing the registration's `createProvider` with one that
//      returns a real provider built around `mountVideoViewer`. This keeps
//      the change scoped to `src/templates/video/**` per issue #28
//      guardrails — no edits to `src/viewerRegistry.ts` or `src/router.ts`.
//
//   3. Self-bootstrap when this script is loaded directly by the per-viewer
//      page shell (`src/templates/video/videoViewer.html`). That shell is
//      the manual-debug entry point: the script reads a `?src=<blob-url>`
//      query param and mounts the viewer into the `data-viewer="video"`
//      host element.

import { mountVideoViewer, VideoViewerHandle } from './videoViewerMain';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export { mountVideoViewer };
export type { VideoViewerHandle };

// --- Provider wiring (side effect on module load) -----------------------

/**
 * Build a `ChromeViewerProvider` that mounts the real video viewer and
 * forwards `dispose` so the router can revoke the blob URL when the viewer
 * is replaced.
 */
function createVideoProvider(): ChromeViewerProvider {
    let handle: VideoViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountVideoViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

/**
 * Patch the registry entry for `omni-viewer.videoViewer`. Idempotent — safe
 * to import multiple times.
 */
function installVideoProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.videoViewer'
    );
    if (!entry) {
        // The registry shape is fixed at compile time; this branch only
        // fires if something deeply weird has happened to the bundle.
        return;
    }
    entry.createProvider = createVideoProvider;
}

installVideoProvider();

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

declare global {
    interface Window {
        __omniMountVideo?: typeof mountVideoViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountVideo = mountVideoViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="video"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="video"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        // Leave the static skeleton in place when no file is present.
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'video.mp4');
        const file = new File([blob], name, { type: blob.type || 'video/mp4' });
        mountVideoViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load video: ${message}`;
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
