import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { mountMermaidViewer, MermaidViewerHandle } from './mermaidViewerMain';

export { mountMermaidViewer };
export type { MermaidViewerHandle };

function createMermaidProvider(): ChromeViewerProvider {
    let handle: MermaidViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountMermaidViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

const registration = VIEWER_REGISTRATIONS.find(
    (r) => r.viewType === 'omni-viewer.mermaidViewer'
);
if (registration) {
    registration.createProvider = createMermaidProvider;
}

declare global {
    interface Window {
        __omniMountMermaid?: typeof mountMermaidViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountMermaid = mountMermaidViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="mermaid"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="mermaid"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) return;

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'diagram.mmd');
        const file = new File([blob], name, { type: blob.type || 'text/vnd.mermaid' });
        await mountMermaidViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load Mermaid: ${message}`;
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
