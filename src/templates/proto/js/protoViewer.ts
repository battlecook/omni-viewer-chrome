import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { mountProtoViewer, ProtoViewerHandle } from './protoViewerMain';

export { mountProtoViewer };
export type { ProtoViewerHandle };

const TARGET_VIEW_TYPE = 'omni-viewer.protoViewer';
const registration = VIEWER_REGISTRATIONS.find((r) => r.viewType === TARGET_VIEW_TYPE);
if (registration) {
    registration.createProvider = (): ChromeViewerProvider => {
        let handle: ProtoViewerHandle | undefined;
        return {
            async render(file: File, container: HTMLElement): Promise<void> {
                handle?.dispose();
                handle = await mountProtoViewer(file, container);
            },
            dispose(): void {
                handle?.dispose();
                handle = undefined;
            }
        };
    };
}

declare global {
    interface Window {
        __omniMountProto?: typeof mountProtoViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountProto = mountProtoViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="proto"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="proto"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) return;

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'schema.proto');
        const file = new File([blob], name, { type: blob.type || 'text/plain' });
        await mountProtoViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load Proto: ${message}`;
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
