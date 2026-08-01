// PlantUML viewer entry — Chrome adapter over omni-viewer-core.
import { render as renderPlantUmlLib } from 'puml-canvas-js';
import {
    mountPlantUmlViewer as mountCorePlantUmlViewer,
    type PlantUmlViewerContext,
    type PlantUmlMountOptions
} from 'omni-viewer-core/viewers/plantuml';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type PlantUmlViewerHandle = ViewerHandle;

function context(): PlantUmlViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n : undefined;
    const ctx: PlantUmlViewerContext = {
        assets: { resolveAssetUrl: async (path) =>
            typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer plantuml]', message) }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    // Preserve the standalone viewer's "Save" behaviour (download a copy).
    ctx.save = { saveFile: async (name, data, mimeType) => downloadBytes(name, data, mimeType) };
    return ctx;
}

function options(): PlantUmlMountOptions {
    return {
        renderPlantUml: (source, doc, theme) =>
            renderPlantUmlLib(source, { document: doc, theme: theme === 'dark' ? 'dark' : 'light' })
    };
}

export async function mountPlantUmlViewer(file: File, container: HTMLElement): Promise<PlantUmlViewerHandle> {
    return mountCorePlantUmlViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context(),
        options()
    );
}

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

const registration = VIEWER_REGISTRATIONS.find((r) => r.viewType === 'omni-viewer.plantumlViewer');
if (registration) registration.createProvider = createPlantUmlProvider;

declare global { interface Window { __omniMountPlantUml?: typeof mountPlantUmlViewer; } }
if (typeof window !== 'undefined') window.__omniMountPlantUml = mountPlantUmlViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="plantuml"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        const blob = await response.blob();
        const name = src.startsWith('data:')
            ? 'diagram.puml'
            : decodeURIComponent(src.split('/').pop() || 'diagram.puml');
        await mountPlantUmlViewer(new File([blob], name, { type: blob.type || 'text/x-plantuml' }), host);
    } catch (error) {
        host.textContent = `Failed to load PlantUML: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="plantuml"]')) {
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
