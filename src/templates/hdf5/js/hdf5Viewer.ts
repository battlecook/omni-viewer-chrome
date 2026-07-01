import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { mountHdf5Viewer, Hdf5ViewerHandle } from './hdf5ViewerMain';

export { mountHdf5Viewer };
export type { Hdf5ViewerHandle };

function createHdf5Provider(): ChromeViewerProvider {
    let handle: Hdf5ViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountHdf5Viewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        },
    };
}

const registration = VIEWER_REGISTRATIONS.find((r) => r.viewType === 'omni-viewer.hdf5Viewer');
if (registration) {
    registration.createProvider = createHdf5Provider;
}

declare global {
    interface Window {
        __omniMountHdf5?: typeof mountHdf5Viewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountHdf5 = mountHdf5Viewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="hdf5"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="hdf5"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) return;

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'sample.h5');
        const file = new File([blob], name, {
            type: blob.type || 'application/octet-stream',
        });
        await mountHdf5Viewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load HDF5 data: ${message}`;
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
