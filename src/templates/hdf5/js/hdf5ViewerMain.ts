// HDF5 viewer mount — Chrome adapter over omni-viewer-core.
import {
    mountHdf5Viewer as mountCoreHdf5Viewer,
    type Hdf5ViewerContext
} from 'omni-viewer-core/viewers/hdf5';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';

export type Hdf5ViewerHandle = ViewerHandle;

function context(): Hdf5ViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n : undefined;
    const ctx: Hdf5ViewerContext = {
        assets: { resolveAssetUrl: async (path) =>
            typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer hdf5]', message) }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    return ctx;
}

export async function mountHdf5Viewer(file: File, container: HTMLElement): Promise<Hdf5ViewerHandle> {
    return mountCoreHdf5Viewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context()
    );
}
