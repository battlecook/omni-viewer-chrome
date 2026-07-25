// Webpack entry for the archive viewer.
//
// Mirrors the wiring used by `templates/image/js/imageViewer.ts`:
//   1. Re-export the public `mountArchiveViewer` so direct imports work.
//   2. Side-effect on module load: patch the registry entry for
//      `omni-viewer.archiveViewer` so the router constructs a real provider
//      backed by `mountArchiveViewer` instead of the placeholder.
//   3. Self-bootstrap when the per-viewer HTML shell
//      (`src/templates/archive/archiveViewer.html`) is loaded directly with
//      a `?src=<blob-url>` query — this is the manual debug entrypoint
//      under `chrome://extensions` "Load unpacked".

import {
    mountArchiveViewer as mountCoreArchiveViewer,
    type ArchiveViewerContext,
    type ArchiveViewerDeps
} from 'omni-viewer-core/viewers/archive';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { createChromeFileSaveService } from '../../../utils/chromeFileSaveService';
import { openArchive } from './archiveLoader';

export type ArchiveViewerHandle = ViewerHandle;

function context(): ArchiveViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage ? chrome.i18n : undefined;
    const ctx: ArchiveViewerContext = {
        assets: { resolveAssetUrl: async (path) => typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer archive]', message) }
    };
    ctx.save = createChromeFileSaveService();
    return ctx;
}

function archiveDeps(onEncryptionDetected: () => void): ArchiveViewerDeps {
    return {
        async openArchive(data) {
            const legacy = await openArchive(new File([data as BlobPart], 'archive'));
            // Encryption detection is best-effort and must not delay the
            // initial entry list (the worker call has its own timeout).
            void legacy.hasEncryptedData()
                .then((encrypted) => { if (encrypted) onEncryptionDetected(); })
                .catch(() => undefined);
            const entries = legacy.entries.map((entry, entryId) => ({
                entryId,
                path: entry.path,
                isDirectory: entry.isDirectory,
                uncompressedSize: entry.size
            }));
            return {
                entries,
                async extract(entryId, options) {
                    const entry = entries[entryId];
                    if (!entry || entry.isDirectory) throw new Error('Archive entry is unavailable');
                    const extracted = await legacy.extract(entry.path);
                    if (extracted.byteLength > options.maxBytes) throw new Error('Archive preview exceeds the configured limit');
                    return extracted;
                },
                close: () => legacy.close()
            };
        }
    };
}

export function addEncryptedArchiveWarning(container: HTMLElement): void {
    const root = container.shadowRoot ?? container;
    const viewer = root.querySelector<HTMLElement>('.omni-viewer--archive');
    if (!viewer || viewer.querySelector('.omni-archive__encryption-warning')) return;

    const warning = document.createElement('div');
    warning.className = 'omni-archive__encryption-warning';
    warning.setAttribute('role', 'status');
    warning.textContent = 'This archive contains encrypted entries. Extraction of those entries is not supported yet.';
    warning.style.cssText = [
        'margin-top:16px',
        'padding:14px 16px',
        'border:1px solid #d97706',
        'border-radius:12px',
        'background:rgba(217,119,6,.14)',
        'color:inherit',
        'line-height:1.5'
    ].join(';');
    const hero = viewer.querySelector('.omni-archive__hero');
    hero?.insertAdjacentElement('afterend', warning);
}

export async function mountArchiveViewer(file: File, container: HTMLElement): Promise<ArchiveViewerHandle> {
    let containsEncryptedEntries = false;
    let mounted = false;
    const onEncryptionDetected = (): void => {
        containsEncryptedEntries = true;
        if (mounted) addEncryptedArchiveWarning(container);
    };
    const handle = await mountCoreArchiveViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context(),
        archiveDeps(onEncryptionDetected)
    );
    mounted = true;
    if (containsEncryptedEntries) addEncryptedArchiveWarning(container);
    return handle;
}

// --- Self-bootstrap for the per-viewer HTML shell -----------------------

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="archive"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="archive"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) {
        host.textContent = 'No archive source provided.';
        return;
    }

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'archive');
        const file = new File([blob], name, { type: blob.type });
        mountArchiveViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load archive: ${message}`;
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
