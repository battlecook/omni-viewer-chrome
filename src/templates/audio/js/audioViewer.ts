// Webpack entry for the audio viewer (issue #24).
//
// Three responsibilities, mirroring the imageViewer/csvViewer pattern:
//
//   1. Re-export `mountAudioViewer` so callers that import the bundled
//      chunk get a stable API surface.
//
//   2. Self-register a real `createProvider` on `VIEWER_REGISTRATIONS`
//      (the array exported by `src/viewerRegistry.ts`). The registry
//      ships a placeholder provider; this entry overrides it at module
//      load time so the router's `mountViewerForFile` builds the real
//      audio viewer instead of the "not implemented" notice. The mutation
//      is idempotent and scoped to `src/templates/audio/**` per issue #24
//      guardrails — no edits to `viewerRegistry.ts` or `router.ts`.
//
//   3. Self-bootstrap when this script is loaded directly by the
//      per-viewer page shell (`templates/audio/audioViewer.html`).
//      That shell is the manual-debug entry point — it reads `?src=...`
//      and mounts into the `[data-viewer="audio"]` host. Production
//      traffic still goes through the SPA + router.

import { mountAudioViewer, AudioController } from './AudioController';
import type { AudioControllerHandle } from './AudioController';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export { mountAudioViewer, AudioController };
export type { AudioControllerHandle };

// --- Provider wiring (side effect on module load) -----------------------

function createAudioProvider(): ChromeViewerProvider {
    let handle: AudioControllerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountAudioViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

function installAudioProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.audioViewer'
    );
    if (!entry) return;
    entry.createProvider = createAudioProvider;
}

installAudioProvider();

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

declare global {
    interface Window {
        __omniMountAudio?: typeof mountAudioViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountAudio = mountAudioViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="audio"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="audio"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) return; // Leave shell as-is when no file was provided.

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'audio');
        const file = new File([blob], name, { type: blob.type });
        await mountAudioViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load audio: ${message}`;
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
