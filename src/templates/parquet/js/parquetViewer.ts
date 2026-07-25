// Parquet viewer entry — Chrome adapter over omni-viewer-core.
import {
    mountParquetViewer as mountCoreParquetViewer,
    type ParquetViewerContext
} from 'omni-viewer-core/viewers/parquet';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { createChromeFileSaveService } from '../../../utils/chromeFileSaveService';

export type ParquetViewerHandle = ViewerHandle;

function context(): ParquetViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n : undefined;
    const ctx: ParquetViewerContext = {
        assets: { resolveAssetUrl: async (path) =>
            typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer parquet]', message) }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    ctx.save = createChromeFileSaveService();
    return ctx;
}

export async function mountParquetViewer(file: File, container: HTMLElement): Promise<ParquetViewerHandle> {
    return mountCoreParquetViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context()
    );
}

declare global { interface Window { __omniMountParquet?: typeof mountParquetViewer; } }
if (typeof window !== 'undefined') window.__omniMountParquet = mountParquetViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="parquet"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'data.parquet');
        await mountParquetViewer(new File([blob], name, { type: blob.type || 'application/octet-stream' }), host);
    } catch (error) {
        host.textContent = `Failed to load Parquet: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="parquet"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
