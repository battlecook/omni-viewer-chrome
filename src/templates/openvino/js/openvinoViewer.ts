// OpenVINO IR viewer entry — Chrome adapter over omni-viewer-core.
//
// An IR is two files that share a base name: the `.xml` topology the core
// receives as its input, and the `.bin` weights it takes as a sidecar. A
// browser hands over one File at a time and has no way to read a neighbour
// off disk, so the `.bin` reaches this adapter one of three ways:
//
//   - picked or dropped together with the `.xml` (app.js pairs them by stem
//     and passes the `.bin` through `options.sidecars`);
//   - attached afterwards through the bar this adapter renders above the
//     core viewer, which remounts with the weights;
//   - `?bin=` next to `?src=` on the standalone debug page.
//
// The topology renders in full without it — only constant previews and byte
// range checks need the weights — so a lone `.xml` is never an error.
import {
    mountOpenVinoViewer as mountCoreOpenVinoViewer,
    type OpenVinoViewerContext
} from 'omni-viewer-core/viewers/openvino';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { t as message } from '../../../utils/i18n';

/** `t()` leaves `$1`/`$2` in place when it falls back to the English
 *  string, so the substitution is applied here for both paths. */
function t(key: string, fallback: string, substitutions: string[] = []): string {
    return message(key, fallback, substitutions).replace(/\$(\d+)/g, (match, index: string) =>
        substitutions[Number(index) - 1] ?? match
    );
}

export type OpenVinoViewerHandle = ViewerHandle;

export interface OpenVinoMountOptions {
    /** The `.bin` that accompanies the `.xml`, when the host already has it. */
    sidecars?: { bin?: Blob | null };
}

function context(): OpenVinoViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n
        : undefined;
    const locale = (typeof document !== 'undefined' ? document.documentElement.lang : '')
        || chromeI18n?.getUILanguage?.()
        || (typeof navigator !== 'undefined' ? navigator.language : '')
        || 'en';
    const ctx: OpenVinoViewerContext = {
        assets: {
            resolveAssetUrl: async (path) =>
                typeof chrome !== 'undefined' && chrome.runtime?.getURL
                    ? chrome.runtime.getURL(path)
                    : path
        },
        i18n: {
            t: (key, args) =>
                chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) ||
                resolveLocalizedCatalogMessage(locale, key, args)
        },
        logger: {
            log: (level, message) =>
                console[level === 'info' ? 'info' : level]('[omni-viewer openvino]', message)
        }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    return ctx;
}

/** `model.xml` -> `model.bin`; how OpenVINO's serializer names the pair. */
export function sidecarBinName(xmlName: string): string {
    return xmlName.replace(/\.xml$/i, '') + '.bin';
}

/**
 * Picks the `.bin` that belongs to `xml` out of a batch of files: the one
 * whose stem matches, or — when the batch holds a single `.bin` — that one,
 * since a user who dropped exactly one weights file meant it for this model.
 */
export function findSidecarBin(xml: { name: string }, files: readonly File[]): File | undefined {
    const bins = files.filter((file) => file !== xml && /\.bin$/i.test(file.name));
    const expected = sidecarBinName(xml.name).toLowerCase();
    return bins.find((file) => file.name.toLowerCase() === expected)
        ?? (bins.length === 1 ? bins[0] : undefined);
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

const BAR_CSS = `
.omni-openvino-sidecar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 12px;margin:0 0 8px;border:1px solid var(--omni-border,rgba(127,127,127,.35));border-radius:8px;font:13px/1.4 system-ui,sans-serif;color:var(--omni-fg,inherit);background:var(--omni-panel,rgba(127,127,127,.08))}
.omni-openvino-sidecar__text{flex:1 1 240px;min-width:0;overflow-wrap:anywhere}
.omni-openvino-sidecar__button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid var(--omni-border,rgba(127,127,127,.5));background:transparent;color:inherit;cursor:pointer}
.omni-openvino-sidecar__button:hover{background:rgba(127,127,127,.15)}
.omni-openvino-sidecar__button:disabled{opacity:.6;cursor:default}
.omni-openvino-sidecar__error{color:var(--omni-danger,#c62828)}
`;

/**
 * Mounts the core viewer under a small bar that reports which weights are
 * attached and lets the user attach or replace them. The core takes its
 * container over with a shadow root, so it gets its own host element —
 * anything else placed in the same element would stop rendering.
 */
export async function mountOpenVinoViewer(
    file: File,
    container: HTMLElement,
    _fileHandle?: unknown,
    signal?: AbortSignal,
    options: OpenVinoMountOptions = {}
): Promise<OpenVinoViewerHandle> {
    const xml = new Uint8Array(await file.arrayBuffer());
    if (signal?.aborted) throw abortError();

    const style = document.createElement('style');
    style.textContent = BAR_CSS;
    const bar = document.createElement('div');
    bar.className = 'omni-openvino-sidecar';
    const text = document.createElement('span');
    text.className = 'omni-openvino-sidecar__text';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'omni-openvino-sidecar__button';
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.bin';
    picker.hidden = true;
    bar.append(text, button, picker);
    const host = document.createElement('div');
    host.className = 'omni-openvino-host';
    container.append(style, bar, host);

    let bin: Blob | null = options.sidecars?.bin ?? null;
    let binName = bin instanceof File ? bin.name : sidecarBinName(file.name);
    let coreHandle: ViewerHandle | undefined;
    let generation = 0;
    let disposed = false;

    const describe = (error?: string): void => {
        text.classList.toggle('omni-openvino-sidecar__error', Boolean(error));
        if (error) {
            text.textContent = error;
        } else if (bin) {
            text.textContent = t('openvinoBinAttached', `Weights: $1 ($2)`, [binName, formatSize(bin.size)]);
        } else {
            text.textContent = t(
                'openvinoNoBin',
                `No .bin attached — constants show byte ranges only. Expected $1 beside the model.`,
                [sidecarBinName(file.name)]
            );
        }
        button.textContent = bin
            ? t('openvinoReplaceBin', 'Replace .bin…')
            : t('openvinoAttachBin', 'Attach .bin…');
    };

    const remount = async (): Promise<void> => {
        const mountGeneration = ++generation;
        coreHandle?.dispose();
        coreHandle = undefined;
        host.replaceChildren();
        button.disabled = true;
        try {
            const weights = bin ? new Uint8Array(await bin.arrayBuffer()) : undefined;
            if (disposed || mountGeneration !== generation || signal?.aborted) return;
            const handle = await mountCoreOpenVinoViewer(
                { fileName: file.name, data: xml, lastModified: file.lastModified },
                host,
                context(),
                { signal, ...(weights ? { sidecars: { bin: weights } } : {}) }
            );
            if (disposed || mountGeneration !== generation || signal?.aborted) {
                handle.dispose();
                return;
            }
            coreHandle = handle;
            describe();
        } finally {
            if (mountGeneration === generation) button.disabled = false;
        }
    };

    button.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
        const picked = picker.files?.[0];
        picker.value = '';
        if (!picked || disposed) return;
        const previous = { bin, binName };
        bin = picked;
        binName = picked.name;
        remount().catch((error: unknown) => {
            // A .bin the parser cannot reconcile leaves the previous view in
            // place: put the old weights back and say why the new ones failed.
            if (disposed) return;
            bin = previous.bin;
            binName = previous.binName;
            remount().catch(() => undefined).finally(() => {
                if (!disposed) describe(t('openvinoBinFailed', `Couldn't apply $1: $2`, [picked.name, errorMessage(error)]));
            });
        });
    });

    describe();
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        generation += 1;
        coreHandle?.dispose();
        coreHandle = undefined;
        style.remove();
        bar.remove();
        host.remove();
    };
    try {
        await remount();
    } catch (error) {
        dispose();
        throw error;
    }
    return { dispose };
}

function createOpenVinoProvider(): ChromeViewerProvider {
    let handle: OpenVinoViewerHandle | undefined;
    let controller: AbortController | undefined;
    let generation = 0;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            const renderGeneration = ++generation;
            controller?.abort();
            handle?.dispose();
            handle = undefined;
            const renderController = new AbortController();
            controller = renderController;
            let nextHandle: OpenVinoViewerHandle;
            try {
                nextHandle = await mountOpenVinoViewer(
                    file,
                    container,
                    undefined,
                    renderController.signal
                );
            } catch (error) {
                if (renderGeneration !== generation || renderController.signal.aborted) return;
                throw error;
            }
            if (renderGeneration !== generation || renderController.signal.aborted) {
                nextHandle.dispose();
                return;
            }
            handle = nextHandle;
        },
        dispose(): void {
            generation += 1;
            controller?.abort();
            controller = undefined;
            handle?.dispose();
            handle = undefined;
        }
    };
}

const registration = VIEWER_REGISTRATIONS.find(
    (item) => item.viewType === 'omni-viewer.openvinoViewer'
);
if (registration) registration.createProvider = createOpenVinoProvider;

declare global {
    interface Window {
        __omniMountOpenVino?: typeof mountOpenVinoViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountOpenVino = mountOpenVinoViewer;

async function fetchFile(src: string, fallbackName: string): Promise<File> {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const name = decodeURIComponent(src.split('/').pop() || fallbackName);
    return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="openvino"]');
    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!host || !src) return;
    try {
        const xml = await fetchFile(src, 'model.xml');
        const binSrc = params.get('bin');
        const bin = binSrc ? await fetchFile(binSrc, sidecarBinName(xml.name)) : null;
        await mountOpenVinoViewer(xml, host, undefined, undefined, { sidecars: { bin } });
    } catch (error) {
        host.textContent = `Failed to load OpenVINO IR data: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="openvino"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function abortError(): Error {
    const error = new Error('OpenVINO viewer mount aborted');
    error.name = 'AbortError';
    return error;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
