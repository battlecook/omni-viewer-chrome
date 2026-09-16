// ONNX viewer entry — Chrome adapter over omni-viewer-core.
import {
    mountOnnxViewer as mountCoreOnnxViewer,
    type OnnxViewerContext
} from 'omni-viewer-core/viewers/onnx';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type OnnxViewerHandle = ViewerHandle;

function context(): OnnxViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n
        : undefined;
    const ctx: OnnxViewerContext = {
        assets: {
            resolveAssetUrl: async (path) =>
                typeof chrome !== 'undefined' && chrome.runtime?.getURL
                    ? chrome.runtime.getURL(path)
                    : path
        },
        i18n: {
            t: (key, args) =>
                chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) ||
                resolveCatalogMessage(key, args)
        },
        logger: {
            log: (level, message) =>
                console[level === 'info' ? 'info' : level]('[omni-viewer onnx]', message)
        }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    return ctx;
}

/**
 * The core parser reads graph topology, types, shapes, and attributes out of
 * the ModelProto without materializing tensor payloads, so handing it the
 * whole file is the intended path.
 */
export async function mountOnnxViewer(
    file: File,
    container: HTMLElement
): Promise<OnnxViewerHandle> {
    return mountCoreOnnxViewer(
        {
            fileName: file.name,
            data: new Uint8Array(await file.arrayBuffer()),
            lastModified: file.lastModified
        },
        container,
        context()
    );
}

function createOnnxProvider(): ChromeViewerProvider {
    let handle: OnnxViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountOnnxViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

const registration = VIEWER_REGISTRATIONS.find(
    (item) => item.viewType === 'omni-viewer.onnxViewer'
);
if (registration) registration.createProvider = createOnnxProvider;

declare global {
    interface Window {
        __omniMountOnnx?: typeof mountOnnxViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountOnnx = mountOnnxViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="onnx"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'model.onnx');
        await mountOnnxViewer(
            new File([blob], name, { type: blob.type || 'application/octet-stream' }),
            host
        );
    } catch (error) {
        host.textContent = `Failed to load ONNX data: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="onnx"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
