import type { NumpyDocument } from 'omni-viewer-core/parsers/numpy';
import {
    parseNumpyArchiveSafely,
    parseNumpyFileSafely
} from './numpyArchiveParser';

interface ParseRequest {
    id: number;
    fileName: string;
    buffer: ArrayBuffer;
    byteOffset: number;
    byteLength: number;
    archive: boolean;
}

type ParseResponse =
    | { id: number; model: NumpyDocument }
    | { id: number; error: string };

const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent<ParseRequest>) => void) | null;
    postMessage: (message: ParseResponse) => void;
};

scope.onmessage = (event): void => {
    const { id, fileName, buffer, byteOffset, byteLength } = event.data;
    const data = new Uint8Array(buffer, byteOffset, byteLength);
    void (event.data.archive
        ? parseNumpyArchiveSafely(data)
        : parseNumpyFileSafely(data, fileName))
        .then((model) => scope.postMessage({ id, model }))
        .catch((error) => scope.postMessage({
            id,
            error: error instanceof Error ? error.message : String(error)
        }));
};
