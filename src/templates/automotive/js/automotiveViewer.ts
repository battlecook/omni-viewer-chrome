import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { mountAutomotiveViewer, AutomotiveViewerHandle } from './automotiveViewerMain';

export { mountAutomotiveViewer };
export type { AutomotiveViewerHandle };

function createAutomotiveProvider(): ChromeViewerProvider {
    let handle: AutomotiveViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountAutomotiveViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

for (const viewType of [
    'omni-viewer.automotiveViewer',
    'omni-viewer.avroViewer',
    'omni-viewer.bagViewer',
    'omni-viewer.stpViewer',
    'omni-viewer.db3Viewer',
    'omni-viewer.reqifViewer',
    'omni-viewer.pcapViewer',
    'omni-viewer.pcapngViewer',
    'omni-viewer.matViewer'
] as const) {
    const registration = VIEWER_REGISTRATIONS.find((r) => r.viewType === viewType);
    if (registration) {
        registration.createProvider = createAutomotiveProvider;
    }
}

declare global {
    interface Window {
        __omniMountAutomotive?: typeof mountAutomotiveViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountAutomotive = mountAutomotiveViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="automotive"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="automotive"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) return;

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'vehicle-data.dbc');
        const file = new File([blob], name, {
            type: blob.type || 'application/octet-stream'
        });
        await mountAutomotiveViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load automotive data: ${message}`;
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
