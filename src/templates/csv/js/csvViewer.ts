// CSV viewer entry — Chrome adapter over omni-viewer-core (Phase 1 pilot).
//
// The parsing, controller state machine, and DOM rendering now live in
// `omni-viewer-core` (see ~/WebstormProjects/omni-viewer-core/DESIGN.md).
// This file is the thin platform adapter the design prescribes:
//   - reads the `File` into bytes (core takes bytes, never file handles),
//   - provides the host services (i18n via chrome.i18n with the core catalog
//     as fallback, clipboard via navigator.clipboard, console logger),
//   - preserves the public contract of the old bundle: an exported
//     `mountCsvViewer(file, container)`, `window.__omniMountCsv`, and the
//     standalone-page self-bootstrap.
//
// The pure helper modules (./csvParser, ./csvSort, ./csvStatistics,
// ./csvDelimiter) were donated to the core and are superseded; they remain in
// the tree only until the remaining local imports/tests migrate.

import {
    mountCsvViewer as mountCoreCsvViewer
} from 'omni-viewer-core/viewers/csv';
import type { CsvViewerContext } from 'omni-viewer-core/viewers/csv';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';
import { createChromeFileSaveService } from '../../../utils/chromeFileSaveService';

export interface CsvViewerHandle {
    dispose(): void;
}

function coreHostContext(): CsvViewerContext {
    const chromeI18n =
        typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage
            ? chrome.i18n
            : null;

    const ctx: CsvViewerContext = {
        assets: {
            resolveAssetUrl: async (assetPath: string) =>
                typeof chrome !== 'undefined' && chrome.runtime?.getURL
                    ? chrome.runtime.getURL(assetPath)
                    : assetPath
        },
        i18n: {
            t: (key, args) => {
                // chrome.i18n message names cannot contain dots; the generated
                // _locales files use underscores. Fall back to the core
                // catalog (single source of message text) when untranslated.
                if (chromeI18n) {
                    const translated = chromeI18n.getMessage(key.replace(/[.-]/g, '_'));
                    if (translated) return translated;
                }
                return resolveCatalogMessage(key, args);
            }
        },
        logger: {
            log: (level, message) => {
                const prefix = '[omni-viewer csv]';
                if (level === 'error') console.error(prefix, message);
                else if (level === 'warn') console.warn(prefix, message);
                else console.info(prefix, message);
            }
        }
    };

    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = {
            writeText: (text: string) => navigator.clipboard.writeText(text)
        };
    }
    ctx.save = createChromeFileSaveService();
    return ctx;
}

async function fileToBytes(file: File): Promise<Uint8Array> {
    if (typeof file.arrayBuffer === 'function') {
        return new Uint8Array(await file.arrayBuffer());
    }
    // FileReader fallback for older jsdom harnesses.
    return new Promise<Uint8Array>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

function isEditableTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element || typeof element.tagName !== 'string') return false;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return true;
    return element.isContentEditable;
}

function hasNonEmptySelection(): boolean {
    return Boolean(document.getSelection()?.toString());
}

/** Restore the legacy Ctrl/Cmd+F and Ctrl/Cmd+C affordances while delegating
 * the actual filtering/copy behavior to core's existing controls. */
export function installCsvKeyboardShortcuts(
    container: HTMLElement,
    copyTsvLabel: string
): () => void {
    const root = container.shadowRoot ?? container;
    const searchInput = root.querySelector<HTMLInputElement>('.omni-csv__search');
    const copyTsvButton = [...root.querySelectorAll<HTMLButtonElement>('.omni-csv__toolbar button')]
        .find((button) => button.textContent === copyTsvLabel);

    const onKeydown = (event: KeyboardEvent): void => {
        const command = event.ctrlKey || event.metaKey;
        if (!command || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key !== 'f' && key !== 'c') return;

        const path = event.composedPath();
        if (!path.includes(container) && !path.includes(root)) return;
        const originalTarget = path[0] ?? event.target;
        if (isEditableTarget(originalTarget)) return;

        if (key === 'f') {
            if (!searchInput) return;
            event.preventDefault();
            searchInput.focus();
            searchInput.select();
            return;
        }

        if (!copyTsvButton || copyTsvButton.disabled || hasNonEmptySelection()) return;
        event.preventDefault();
        copyTsvButton.click();
    };

    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
}

/**
 * Mount the CSV viewer for `file` inside `container`. Same signature the
 * legacy SPA (`mountAdvancedViewer`) and the router expect.
 */
export async function mountCsvViewer(
    file: File,
    container: HTMLElement
): Promise<CsvViewerHandle> {
    const data = await fileToBytes(file);
    // Keep this diagnostic at the Chrome adapter boundary.  Seeing both
    // messages in DevTools proves that the file bytes crossed into the
    // omni-viewer-core CSV mount function and that it produced its root UI.
    console.info('[omni-viewer csv] core mount requested', {
        implementation: 'omni-viewer-core/viewers/csv',
        fileName: file.name,
        byteLength: data.byteLength
    });
    const input: { fileName: string; data: Uint8Array; lastModified?: number } = {
        fileName: file.name,
        data
    };
    if (typeof file.lastModified === 'number') {
        input.lastModified = file.lastModified;
    }
    const ctx = coreHostContext();
    const handle: ViewerHandle = await mountCoreCsvViewer(
        input,
        container,
        ctx
    );
    const removeKeyboardShortcuts = installCsvKeyboardShortcuts(
        container,
        ctx.i18n.t('csv.copyTsv')
    );
    // Core uses an open Shadow DOM by default, so query it first.  The
    // fallback keeps this diagnostic correct if core switches to light DOM.
    const coreRoot = container.shadowRoot ?? container;
    const table = coreRoot.querySelector('table.omni-csv__table');
    console.info('[omni-viewer csv] core mount completed', {
        implementation: 'omni-viewer-core/viewers/csv',
        rootCreated: coreRoot.querySelector('.omni-csv') !== null,
        renderRoot: container.shadowRoot ? 'shadow-dom' : 'light-dom',
        rows: table ? Math.max(0, table.querySelectorAll('tbody tr').length) : 0,
        columns: table ? table.querySelectorAll('thead th').length : 0
    });
    let disposed = false;
    return {
        dispose(): void {
            if (disposed) return;
            disposed = true;
            removeKeyboardShortcuts();
            handle.dispose();
        }
    };
}

// ---------------------------------------------------------------------------
// Standalone per-viewer page bootstrap (unchanged contract; see router.ts).
// ---------------------------------------------------------------------------

declare global {
    interface Window {
        __omniMountCsv?: typeof mountCsvViewer;
    }
}

if (typeof window !== 'undefined') {
    window.__omniMountCsv = mountCsvViewer;
}

function isSelfBootstrap(): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector('[data-viewer="csv"]');
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="csv"]');
    if (!host) return;

    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) return;

    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'data.csv');
        const file = new File([blob], name, { type: blob.type || 'text/csv' });
        await mountCsvViewer(file, host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.textContent = `Failed to load CSV: ${message}`;
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
