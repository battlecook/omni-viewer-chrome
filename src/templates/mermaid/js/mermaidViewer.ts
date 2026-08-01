// Mermaid viewer entry — Chrome adapter over omni-viewer-core.
import mermaid from 'mermaid';
import {
    mountMermaidViewer as mountCoreMermaidViewer,
    type MermaidViewerContext,
    type MermaidMountOptions
} from 'omni-viewer-core/viewers/mermaid';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type MermaidViewerHandle = ViewerHandle;

function context(): MermaidViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n : undefined;
    const ctx: MermaidViewerContext = {
        assets: { resolveAssetUrl: async (path) =>
            typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer mermaid]', message) }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    // Preserve the standalone viewer's "Save" behaviour (download a copy).
    ctx.save = { saveFile: async (name, data, mimeType) => downloadBytes(name, data, mimeType) };
    return ctx;
}

let renderCounter = 0;
function options(): MermaidMountOptions {
    return {
        renderMermaid: async (id, source, theme) => {
            // `htmlLabels: false` keeps labels as SVG <text>: core's SVG sanitizer
            // strips <foreignObject>, which mermaid uses for HTML labels by default.
            mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                htmlLabels: false,
                theme: (theme ?? 'default') as never
            });
            const result = await mermaid.render(id || `omni-mermaid-${Date.now()}-${renderCounter++}`, source);
            return result.svg;
        }
    };
}

export async function mountMermaidViewer(file: File, container: HTMLElement): Promise<MermaidViewerHandle> {
    return mountCoreMermaidViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context(),
        options()
    );
}

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

const registration = VIEWER_REGISTRATIONS.find((r) => r.viewType === 'omni-viewer.mermaidViewer');
if (registration) registration.createProvider = createMermaidProvider;

declare global { interface Window { __omniMountMermaid?: typeof mountMermaidViewer; } }
if (typeof window !== 'undefined') window.__omniMountMermaid = mountMermaidViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="mermaid"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'diagram.mmd');
        await mountMermaidViewer(new File([blob], name, { type: blob.type || 'text/vnd.mermaid' }), host);
    } catch (error) {
        host.textContent = `Failed to load Mermaid: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="mermaid"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function downloadBytes(name: string, data: Uint8Array, mimeType: string): void {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mimeType || 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
