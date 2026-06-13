// Webpack entry for the YAML viewer (issue #64).
//
// Mirrors the JSON viewer entry (`templates/json/js/jsonViewer.ts`):
//
//   1. Re-export the public surface (`mountYamlViewer`).
//   2. As a side effect at module load, mutate the matching entry in
//      `VIEWER_REGISTRATIONS` so the router constructs a real provider
//      instead of the placeholder. This is the agreed self-register
//      pattern that keeps the change scoped to `src/templates/yaml/**`.
//   3. Self-bootstrap when loaded directly by the per-viewer HTML shell
//      (`src/templates/yaml/yamlViewer.html`) for manual debugging via
//      "Load unpacked" + chrome://extensions.

import { mountYamlViewer, YamlViewerHandle } from './yamlViewerMain';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export { mountYamlViewer };
export type { YamlViewerHandle };

// --- Provider wiring (side effect on module load) -----------------------

function createYamlProvider(): ChromeViewerProvider {
    let handle: YamlViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountYamlViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

function installYamlProvider(): void {
    const entry = VIEWER_REGISTRATIONS.find(
        (r) => r.viewType === 'omni-viewer.yamlViewer'
    );
    if (!entry) return;
    entry.createProvider = createYamlProvider;
}

installYamlProvider();

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

declare global {
    interface Window {
        __omniMountYaml?: typeof mountYamlViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountYaml = mountYamlViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="yaml"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="yaml"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        // Leave the static skeleton in place when no file is supplied.
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'data.yaml');
        const file = new File([blob], name, { type: blob.type || 'text/yaml' });
        await mountYamlViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load YAML: ${message}`;
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
