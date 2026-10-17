// Shapefile (.shp) viewer entry — Chrome adapter over omni-viewer-core.
//
// A shapefile is a set of files that share a base name. The `.shp` the core
// receives as its input holds the geometry alone; the names and attributes of
// those shapes live in a `.dbf` beside it, and the coordinate system they are
// expressed in lives in a `.prj`. A browser hands over one File at a time and
// has no way to read a neighbour off disk, so both sidecars reach this adapter
// one of three ways:
//
//   - picked or dropped together with the `.shp` (app.js pairs them by stem
//     and passes them through `options.sidecars`);
//   - attached afterwards through the bar this adapter renders above the core
//     viewer, which remounts with them;
//   - `?dbf=` / `?prj=` next to `?src=` on the standalone debug page.
//
// The geometry renders in full without either — a lone `.shp` draws its shapes
// in native coordinates with no attribute table — so neither is an error.
//
// The self-loading core entry is used so a projected `.prj` is reprojected to
// WGS84 through proj4 (an optional peer this platform installs). Without it the
// core falls back to native coordinates on its own.
import {
    mountSelfLoadingShapefileViewer as mountCoreShapefileViewer,
    type ShapefileViewerContext
} from 'omni-viewer-core/viewers/shapefile/self-loading';
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

export type ShapefileViewerHandle = ViewerHandle;

export interface ShapefileMountOptions {
    /** The companions that share the `.shp`'s base name, when the host has them. */
    sidecars?: { dbf?: Blob | null; prj?: Blob | null };
}

type SidecarKind = 'dbf' | 'prj';

function context(): ShapefileViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n
        : undefined;
    const locale = (typeof document !== 'undefined' ? document.documentElement.lang : '')
        || chromeI18n?.getUILanguage?.()
        || (typeof navigator !== 'undefined' ? navigator.language : '')
        || 'en';
    return {
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
                console[level === 'info' ? 'info' : level]('[omni-viewer shapefile]', message)
        }
    };
}

/** `map.shp` -> `map.dbf` / `map.prj`; the set shares one base name. */
export function sidecarName(shpName: string, kind: SidecarKind): string {
    return `${shpName.replace(/\.shp$/i, '')}.${kind}`;
}

/**
 * Picks the companion of `kind` that belongs to `shp` out of a batch of files:
 * the one whose stem matches, or — when the batch holds a single file of that
 * extension — that one, since a user who dropped exactly one meant it for this
 * shapefile.
 */
export function findSidecar(
    shp: { name: string },
    files: readonly File[],
    kind: SidecarKind
): File | undefined {
    const pattern = new RegExp(`\\.${kind}$`, 'i');
    const candidates = files.filter((file) => file !== shp && pattern.test(file.name));
    const expected = sidecarName(shp.name, kind).toLowerCase();
    return candidates.find((file) => file.name.toLowerCase() === expected)
        ?? (candidates.length === 1 ? candidates[0] : undefined);
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
.omni-shapefile-sidecars{display:flex;flex-direction:column;gap:6px;padding:8px 12px;margin:0 0 8px;border:1px solid var(--omni-border,rgba(127,127,127,.35));border-radius:8px;font:13px/1.4 system-ui,sans-serif;color:var(--omni-fg,inherit);background:var(--omni-panel,rgba(127,127,127,.08))}
.omni-shapefile-sidecar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.omni-shapefile-sidecar__text{flex:1 1 240px;min-width:0;overflow-wrap:anywhere}
.omni-shapefile-sidecar__button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid var(--omni-border,rgba(127,127,127,.5));background:transparent;color:inherit;cursor:pointer}
.omni-shapefile-sidecar__button:hover{background:rgba(127,127,127,.15)}
.omni-shapefile-sidecar__button:disabled{opacity:.6;cursor:default}
.omni-shapefile-sidecar__error{color:var(--omni-danger,#c62828)}
`;

interface SidecarSlot {
    kind: SidecarKind;
    file: Blob | null;
    name: string;
    text: HTMLSpanElement;
    button: HTMLButtonElement;
    picker: HTMLInputElement;
    error?: string;
}

/**
 * Mounts the core viewer under a small bar that reports which companions are
 * attached and lets the user attach or replace each. The core takes its
 * container over with a shadow root, so it gets its own host element —
 * anything else placed in the same element would stop rendering.
 */
export async function mountShapefileViewer(
    file: File,
    container: HTMLElement,
    _fileHandle?: unknown,
    signal?: AbortSignal,
    options: ShapefileMountOptions = {}
): Promise<ShapefileViewerHandle> {
    const shp = new Uint8Array(await file.arrayBuffer());
    if (signal?.aborted) throw abortError();

    const style = document.createElement('style');
    style.textContent = BAR_CSS;
    const bar = document.createElement('div');
    bar.className = 'omni-shapefile-sidecars';
    const host = document.createElement('div');
    host.className = 'omni-shapefile-host';

    const slots: SidecarSlot[] = (['dbf', 'prj'] as const).map((kind) => {
        const row = document.createElement('div');
        row.className = 'omni-shapefile-sidecar';
        const text = document.createElement('span');
        text.className = 'omni-shapefile-sidecar__text';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'omni-shapefile-sidecar__button';
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = `.${kind}`;
        picker.hidden = true;
        row.append(text, button, picker);
        bar.append(row);
        const attached = options.sidecars?.[kind] ?? null;
        return {
            kind,
            file: attached,
            name: attached instanceof File ? attached.name : sidecarName(file.name, kind),
            text,
            button,
            picker
        };
    });

    container.append(style, bar, host);

    let coreHandle: ViewerHandle | undefined;
    let generation = 0;
    let disposed = false;

    const describe = (slot: SidecarSlot): void => {
        slot.text.classList.toggle('omni-shapefile-sidecar__error', Boolean(slot.error));
        if (slot.error) {
            slot.text.textContent = slot.error;
        } else if (slot.file && slot.kind === 'dbf') {
            slot.text.textContent = t('shapefileDbfAttached', `Attributes: $1 ($2)`, [
                slot.name,
                formatSize(slot.file.size)
            ]);
        } else if (slot.file) {
            slot.text.textContent = t('shapefilePrjAttached', `Projection: $1`, [slot.name]);
        } else if (slot.kind === 'dbf') {
            slot.text.textContent = t(
                'shapefileNoDbf',
                `No .dbf attached — shapes show geometry only, with no attribute table. Expected $1 beside the geometry.`,
                [sidecarName(file.name, 'dbf')]
            );
        } else {
            slot.text.textContent = t(
                'shapefileNoPrj',
                `No .prj attached — coordinates render as stored, without reprojection. Expected $1 beside the geometry.`,
                [sidecarName(file.name, 'prj')]
            );
        }
        slot.button.textContent = slot.file
            ? t('shapefileReplaceSidecar', `Replace .$1…`, [slot.kind])
            : t('shapefileAttachSidecar', `Attach .$1…`, [slot.kind]);
    };

    const describeAll = (): void => slots.forEach(describe);

    const remount = async (): Promise<void> => {
        const mountGeneration = ++generation;
        coreHandle?.dispose();
        coreHandle = undefined;
        host.replaceChildren();
        slots.forEach((slot) => { slot.button.disabled = true; });
        try {
            const dbfSlot = slots.find((slot) => slot.kind === 'dbf');
            const prjSlot = slots.find((slot) => slot.kind === 'prj');
            const dbf = dbfSlot?.file
                ? new Uint8Array(await dbfSlot.file.arrayBuffer())
                : undefined;
            // Decoded from the bytes rather than through `Blob.text()`: the
            // core wants WKT as a string either way, and this keeps both
            // companions on the one read path.
            const prj = prjSlot?.file
                ? new TextDecoder().decode(await prjSlot.file.arrayBuffer())
                : undefined;
            if (disposed || mountGeneration !== generation || signal?.aborted) return;
            const handle = await mountCoreShapefileViewer(
                { fileName: file.name, data: shp, lastModified: file.lastModified },
                host,
                context(),
                {
                    signal,
                    ...(dbf || prj !== undefined
                        ? { sidecars: { ...(dbf ? { dbf } : {}), ...(prj !== undefined ? { prj } : {}) } }
                        : {})
                }
            );
            if (disposed || mountGeneration !== generation || signal?.aborted) {
                handle.dispose();
                return;
            }
            coreHandle = handle;
            describeAll();
        } finally {
            if (mountGeneration === generation) {
                slots.forEach((slot) => { slot.button.disabled = false; });
            }
        }
    };

    for (const slot of slots) {
        slot.button.addEventListener('click', () => slot.picker.click());
        slot.picker.addEventListener('change', () => {
            const picked = slot.picker.files?.[0];
            slot.picker.value = '';
            if (!picked || disposed) return;
            const previous = { file: slot.file, name: slot.name };
            slot.file = picked;
            slot.name = picked.name;
            slot.error = undefined;
            remount().catch((error: unknown) => {
                // A companion the parser cannot reconcile leaves the previous
                // view in place: put the old one back and say why the new one
                // failed.
                if (disposed) return;
                slot.file = previous.file;
                slot.name = previous.name;
                remount().catch(() => undefined).finally(() => {
                    if (disposed) return;
                    slot.error = t('shapefileSidecarFailed', `Couldn't apply $1: $2`, [
                        picked.name,
                        errorMessage(error)
                    ]);
                    describe(slot);
                });
            });
        });
    }

    describeAll();
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

function createShapefileProvider(): ChromeViewerProvider {
    let handle: ShapefileViewerHandle | undefined;
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
            let nextHandle: ShapefileViewerHandle;
            try {
                nextHandle = await mountShapefileViewer(
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
    (item) => item.viewType === 'omni-viewer.shapefileViewer'
);
if (registration) registration.createProvider = createShapefileProvider;

declare global {
    interface Window {
        __omniMountShapefile?: typeof mountShapefileViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountShapefile = mountShapefileViewer;

async function fetchFile(src: string, fallbackName: string): Promise<File> {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const name = decodeURIComponent(src.split('/').pop() || fallbackName);
    return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="shapefile"]');
    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!host || !src) return;
    try {
        const shp = await fetchFile(src, 'map.shp');
        const dbfSrc = params.get('dbf');
        const prjSrc = params.get('prj');
        await mountShapefileViewer(shp, host, undefined, undefined, {
            sidecars: {
                dbf: dbfSrc ? await fetchFile(dbfSrc, sidecarName(shp.name, 'dbf')) : null,
                prj: prjSrc ? await fetchFile(prjSrc, sidecarName(shp.name, 'prj')) : null
            }
        });
    } catch (error) {
        host.textContent = `Failed to load Shapefile data: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="shapefile"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function abortError(): Error {
    const error = new Error('Shapefile viewer mount aborted');
    error.name = 'AbortError';
    return error;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
