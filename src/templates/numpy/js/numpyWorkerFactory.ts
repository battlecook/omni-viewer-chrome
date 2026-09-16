import type { NumpyParserWorkerLike } from './numpyViewer';

/** Kept separate so Jest can replace the ESM worker URL factory. */
export function createNumpyParserWorker(): NumpyParserWorkerLike {
    return new Worker(
        new URL('./numpyParserWorker.ts', import.meta.url),
        { type: 'module', name: 'omni-viewer-numpy-parser' }
    );
}
