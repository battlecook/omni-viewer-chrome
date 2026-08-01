// PDF viewer entry — Chrome adapter over omni-viewer-core.
//
// Chrome keeps only file/URL/i18n/download integration here. Rendering,
// zoom, page lifecycle and future PDF editing behavior live in the core.

// Static imports on purpose: this entry is already lazy-loaded by app.js's
// mountAdvancedViewer, and webpack async chunks are one more thing that can
// 404 inside an extension page. The bundled pdfjs API version is locked to
// the worker file webpack copies into dist/assets/pdfjs/.
import * as pdfjsModule from 'pdfjs-dist/build/pdf.mjs';
import * as pdfLibModule from 'pdf-lib';
import {
    mountPdfViewer as mountCorePdfViewer,
    type PdfJsModule,
    type PdfViewerContext,
    type PdfViewerDeps
} from 'omni-viewer-core/viewers/pdf';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { createChromeFileSaveService } from '../../../utils/chromeFileSaveService';

const coreDeps: PdfViewerDeps = {
    loadPdfjs: async () => pdfjsModule as unknown as PdfJsModule,
    loadPdfLib: async () => pdfLibModule
};

export interface PdfViewerHandle { dispose(): void; }

function context(): PdfViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n : undefined;
    const ctx: PdfViewerContext = {
        assets: { resolveAssetUrl: async (assetPath) => {
            // dist/assets/pdfjs/* is copied from the same pdfjs-dist install
            // webpack bundles, so the core's asset path maps straight through.
            const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL
                ? chrome.runtime.getURL(assetPath)
                : assetPath;
            // The pdfjs worker must actually be reachable, or getDocument falls
            // back to a fake worker and getAttachments() can silently fail —
            // which drops the hybrid sidecar and reopens annotated PDFs flat.
            // Probe once and surface the failure (missing web_accessible_resources
            // entry, 404, CSP) instead of degrading quietly.
            if (assetPath.includes('pdf.worker')) void probeWorkerAsset(url);
            return url;
        } },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer pdf]', message) }
    };
    if (typeof document !== 'undefined') {
        ctx.save = createChromeFileSaveService();
        ctx.filePick = { pickFile: ({ accept, maxBytes }) => new Promise((resolve) => {
            const picker = document.createElement('input'); picker.type = 'file'; picker.accept = accept.join(',');
            picker.onchange = async () => { const file = picker.files?.[0]; if (!file || (maxBytes !== undefined && file.size > maxBytes)) return resolve(undefined); resolve({ fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), mimeType: file.type || undefined }); };
            picker.click();
        }) };
    }
    return ctx;
}

async function bytes(file: File): Promise<Uint8Array> { return new Uint8Array(await file.arrayBuffer()); }

// Diagnostic only: confirm the worker asset resolves to a fetchable resource.
// A non-ok/failed fetch here explains missing-annotation-on-reopen reports —
// the sidecar read (getAttachments) needs a real worker to parse the PDF.
async function probeWorkerAsset(url: string): Promise<void> {
    try {
        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) {
            console.error('[omni-viewer pdf] worker asset not reachable', response.status, url);
        }
    } catch (error) {
        console.error('[omni-viewer pdf] worker asset fetch failed', String(error), url);
    }
}

export async function mountPdfViewer(file: File, container: HTMLElement): Promise<PdfViewerHandle> {
    // The SPA panel is content-sized by default. Give the core viewer a real
    // viewport so its page pane (rather than the whole extension document)
    // owns vertical scrolling.
    container.style.height = 'min(78vh, 900px)';
    container.style.minHeight = '560px';
    const data = await bytes(file);
    return mountCorePdfViewer(
        { fileName: file.name, data, lastModified: file.lastModified },
        container,
        context(),
        coreDeps
    );
}

declare global { interface Window { __omniMountPdf?: typeof mountPdfViewer; } }
if (typeof window !== 'undefined') window.__omniMountPdf = mountPdfViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="pdf"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try { const response = await fetch(src); await mountPdfViewer(new File([await response.blob()], decodeURIComponent(src.split('/').pop() || 'document.pdf'), { type: 'application/pdf' }), host); }
    catch (error) { host.textContent = `Failed to load PDF: ${String(error)}`; }
}
if (typeof document !== 'undefined' && document.querySelector('[data-viewer="pdf"]')) void selfBootstrap();
