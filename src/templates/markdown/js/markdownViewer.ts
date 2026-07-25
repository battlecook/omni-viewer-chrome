import {
    mountMarkdownViewer as mountCoreMarkdownViewer,
    type MarkdownViewerContext
} from 'omni-viewer-core/viewers/markdown';
import { loadMarkdownViewerDeps } from 'omni-viewer-core/viewers/markdown/self-loading';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { createChromeFileSaveService } from '../../../utils/chromeFileSaveService';

export type MarkdownViewerHandle = ViewerHandle;

/**
 * Minimal shape of the File System Access `FileSystemFileHandle` we rely on for
 * in-place writeback. Only the launchQueue (file_handlers) entry path supplies
 * one; input/drop paths pass `undefined`.
 */
interface WritableFileHandle {
    requestPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
    createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
}

function context(fileHandle?: WritableFileHandle | null): MarkdownViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage ? chrome.i18n : undefined;
    const ctx: MarkdownViewerContext = {
        assets: { resolveAssetUrl: async (path) => typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer markdown]', message) }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    ctx.navigation = { openExternalUrl: async (url) => { window.open(url, '_blank', 'noopener,noreferrer'); } };
    ctx.save = createChromeFileSaveService();
    // Only the file_handlers (launchQueue) path hands us a writable handle, so
    // writeback overwrites the original file in place. Without it (input/drop)
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
 * Load katex.min.css into a target node. The core renders math into an
 * isolated shadow root and ships no math CSS, so the layout selectors
 * (`.katex*`) must be injected into that same root. `@font-face` rules only
 * register when they live in the outer document, so we also add the stylesheet
 * to <head>. Idempotent via the data-attribute guard.
 *
 * `target` must be an Element or ShadowRoot (e.g. `document.head`, not
 * `document` — appending a <link> straight to the document node throws
 * "Only one element on document allowed").
 */
function injectKatexCss(target: ParentNode & Node): void {
    if ((target as Element | ShadowRoot).querySelector('link[data-omni-katex]')) return;
    const href = typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL('assets/katex/katex.min.css')
        : 'assets/katex/katex.min.css';
    const link = document.createElement('link');
    link.setAttribute('data-omni-katex', '');
    link.rel = 'stylesheet';
    link.href = href;
    target.appendChild(link);
}

export async function mountMarkdownViewer(
    file: File,
    container: HTMLElement,
    fileHandle?: WritableFileHandle | null
): Promise<MarkdownViewerHandle> {
    const handle = await mountCoreMarkdownViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context(fileHandle),
        await loadMarkdownViewerDeps()
    );
    // Core mounts into an open shadow root by default; style it plus <head>
    // (for @font-face). Falls back to the light-DOM container when scoped.
    if (typeof document !== 'undefined') {
        if (document.head) injectKatexCss(document.head);
        const shadow = container.shadowRoot;
        if (shadow) injectKatexCss(shadow);
    }
    return handle;
}

declare global {
    interface Window {
        __omniMountMarkdown?: typeof mountMarkdownViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountMarkdown = mountMarkdownViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="markdown"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        const blob = await response.blob();
        const name = src.startsWith('data:')
            ? 'document.md'
            : decodeURIComponent(src.split('/').pop() || 'document.md');
        await mountMarkdownViewer(new File([blob], name, {
            type: blob.type || 'text/markdown'
        }), host);
    } catch (error) {
        host.textContent = `Failed to load Markdown: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="markdown"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
