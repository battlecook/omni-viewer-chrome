import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { mountPlantUmlViewer, PlantUmlViewerHandle } from './plantumlViewerMain';

export { mountPlantUmlViewer };
export type { PlantUmlViewerHandle };

function createPlantUmlProvider(): ChromeViewerProvider {
    let handle: PlantUmlViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountPlantUmlViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

const registration = VIEWER_REGISTRATIONS.find(
    (r) => r.viewType === 'omni-viewer.plantumlViewer'
);
if (registration) {
    registration.createProvider = createPlantUmlProvider;
}

declare global {
    interface Window {
        __omniMountPlantUml?: typeof mountPlantUmlViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountPlantUml = mountPlantUmlViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="plantuml"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="plantuml"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) return;

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = src.startsWith('data:')
            ? 'diagram.puml'
            : decodeURIComponent(src.split('/').pop() || 'diagram.puml');
        const file = new File([blob], name, { type: blob.type || 'text/x-plantuml' });
        await mountPlantUmlViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load PlantUML: ${message}`;
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
