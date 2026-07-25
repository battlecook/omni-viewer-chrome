// Excel viewer entry — Chrome adapter over omni-viewer-core.
import * as xlsx from 'xlsx';
import {
    mountExcelViewer as mountCoreExcelViewer,
    type ExcelViewerContext,
    type ExcelViewerHandle
} from 'omni-viewer-core/viewers/excel';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { createChromeFileSaveService } from '../../../utils/chromeFileSaveService';

function context(): ExcelViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n : undefined;
    const ctx: ExcelViewerContext = {
        assets: { resolveAssetUrl: async (path) =>
            typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer excel]', message) }
    };
    if (navigator.clipboard) ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    ctx.save = createChromeFileSaveService();
    return ctx;
}

export async function mountExcelViewer(file: File, container: HTMLElement): Promise<ExcelViewerHandle> {
    return mountCoreExcelViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context(),
        { loadXlsx: async () => xlsx }
    );
}

declare global { interface Window { __omniMountExcel?: typeof mountExcelViewer; } }
if (typeof window !== 'undefined') window.__omniMountExcel = mountExcelViewer;

// --- Self-bootstrap for the per-viewer HTML shell -----------------------
// Loaded directly by templates/excel/excelViewer.html (`?src=<blob-url>`) —
// the manual-debug entry under chrome://extensions "Load unpacked".
async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="excel"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'workbook.xlsx');
        await mountExcelViewer(new File([blob], name, { type: blob.type }), host);
    } catch (error) {
        host.textContent = `Failed to load Excel document: ${error instanceof Error ? error.message : String(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="excel"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}
