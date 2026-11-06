import { mountSelfLoadingMeshViewer as mountCoreViewer } from 'omni-viewer-core/viewers/mesh/self-loading';
import { isMeshRelativePath } from 'omni-viewer-core/parsers/mesh';
import type { DocumentAssetsService } from 'omni-viewer-core/host';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;

/** Resolve only files explicitly selected alongside the glTF; never fetch a URL. */
export function createMeshDocumentAssets(model: File, files: readonly File[]): DocumentAssetsService {
    const modelPath = model.webkitRelativePath || model.name;
    const directory = modelPath.slice(0, modelPath.lastIndexOf('/') + 1);
    return {
        async resolve(uri) {
            if (!isMeshRelativePath(uri)) return null;
            let path: string;
            try { path = decodeURIComponent(uri).split('/').filter(part => part !== '.').join('/'); } catch { return null; }
            const fullPath = directory + path;
            const exact = files.filter(file => (file.webkitRelativePath || file.name) === fullPath);
            // A multi-file picker may flatten folder paths. Only use a basename
            // when it identifies exactly one of the supplied files.
            const candidates = exact.length ? exact : files.filter(file =>
                !file.webkitRelativePath && file.name === path.split('/').pop());
            if (candidates.length !== 1 || candidates[0].size > MAX_RESOURCE_BYTES) return null;
            const url = URL.createObjectURL(candidates[0]);
            let disposed = false;
            return { url, dispose() {
                if (!disposed) { disposed = true; URL.revokeObjectURL(url); }
            } };
        }
    };
}

export const mountMeshViewer = createChromeCoreViewerMount('mesh', mountCoreViewer, (file, options) => ({
    documentAssets: createMeshDocumentAssets(file, options.companions ?? [])
}));

declare global { interface Window { __omniMountMesh?: typeof mountMeshViewer; } }
if (typeof window !== 'undefined') window.__omniMountMesh = mountMeshViewer;
