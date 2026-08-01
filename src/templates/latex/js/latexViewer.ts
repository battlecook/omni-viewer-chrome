// LaTeX viewer entry — Chrome adapter over omni-viewer-core.
//
// The core viewer is a *partial render* preview by design: it renders document
// structure, tables and math, and leaves everything it cannot model (TikZ,
// algorithm, …) visible as its original source with a warning, under a
// permanent "partial preview" badge. That is the specified behaviour, not a
// defect (omni-viewer-core/docs/viewers/latex.md L6/L8) — the adapter must not
// paper over it.
//
// `\input`/`\include` stay unresolved: the core resolves them only when the
// host injects `LatexMountOptions.resolveInclude`, and Chrome hands a viewer a
// lone File (or a single FileSystemFileHandle) with no access to its siblings.
// Wiring it would mean prompting for a directory handle, which is a product
// decision rather than a detail of this adapter.

import {
    mountLatexViewer as mountCoreLatexViewer,
    type LatexMountOptions,
    type LatexViewerContext
} from 'omni-viewer-core/viewers/latex';
import { loadLatexViewerDeps } from 'omni-viewer-core/viewers/latex/self-loading';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { createChromeFileSaveService } from '../../../utils/chromeFileSaveService';
import { installKatexStyles } from '../../../utils/katexAssets';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';

export type LatexViewerHandle = ViewerHandle;

/**
 * Minimal shape of the File System Access `FileSystemFileHandle` we rely on for
 * in-place writeback. Only the launchQueue (file_handlers) entry path supplies
 * one; input/drop paths pass `undefined`.
 */
interface WritableFileHandle {
    requestPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
    createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
}

function context(fileHandle?: WritableFileHandle | null): LatexViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage ? chrome.i18n : undefined;
    const ctx: LatexViewerContext = {
        assets: { resolveAssetUrl: async (path) => typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer latex]', message) }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    ctx.navigation = { openExternalUrl: async (url) => { window.open(url, '_blank', 'noopener,noreferrer'); } };
    ctx.save = createChromeFileSaveService();
    // Only the file_handlers (launchQueue) path hands us a writable handle, so
    // writeback overwrites the original .tex in place. Without it (input/drop)
    // Ctrl+S falls back to the download-based save service above.
    if (fileHandle) {
        ctx.writeback = {
            async write(bytes: Uint8Array): Promise<void> {
                // Called from the Ctrl+S keydown handler, i.e. inside a user
                // gesture, so requestPermission may show the readwrite prompt.
                const permission = await fileHandle.requestPermission({ mode: 'readwrite' });
                if (permission !== 'granted') throw new Error('write permission denied');
                const writable = await fileHandle.createWritable();
                await writable.write(bytes);
                await writable.close();
            }
        };
    }
    return ctx;
}

/**
 * Renderers are injected through the mount *options* (`deps`), not as a
 * positional argument the way the markdown viewer takes them — every LaTeX
 * dependency is optional and the viewer is fully usable without them.
 *
 * `loadLatexViewerDeps()` returns `math` only when DOMPurify loaded too, which
 * is what the core requires: an unsanitizable renderer is refused rather than
 * trusted. Without KaTeX the preview still shows structure and outline and
 * formulas stay as TeX source — we do not force source mode.
 */
async function options(): Promise<LatexMountOptions> {
    return { deps: await loadLatexViewerDeps() };
}

export async function mountLatexViewer(
    file: File,
    container: HTMLElement,
    fileHandle?: WritableFileHandle | null
): Promise<LatexViewerHandle> {
    const handle = await mountCoreLatexViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context(fileHandle),
        await options()
    );
    // The core injects its own stylesheet into the shadow root but never
    // katex.css — math layout and its @font-face rules are the adapter's
    // responsibility (docs/viewers/latex.md §5).
    installKatexStyles(container);
    return handle;
}

function createLatexProvider(): ChromeViewerProvider {
    let handle: LatexViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountLatexViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

const registration = VIEWER_REGISTRATIONS.find((r) => r.viewType === 'omni-viewer.latexViewer');
if (registration) registration.createProvider = createLatexProvider;

declare global {
    interface Window {
        __omniMountLatex?: typeof mountLatexViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountLatex = mountLatexViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="latex"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        const blob = await response.blob();
        const name = src.startsWith('data:')
            ? 'document.tex'
            : decodeURIComponent(src.split('/').pop() || 'document.tex');
        await mountLatexViewer(new File([blob], name, { type: blob.type || 'text/x-tex' }), host);
    } catch (error) {
        host.textContent = `Failed to load LaTeX: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="latex"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
