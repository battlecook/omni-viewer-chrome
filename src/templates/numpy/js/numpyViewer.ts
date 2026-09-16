// NumPy viewer entry — Chrome adapter over omni-viewer-core.
import {
    mountNumpyDocument as mountCoreNumpyDocument,
    mountNumpyViewer as mountCoreNumpyViewer,
    type NumpyDocument,
    type NumpyViewerContext
} from 'omni-viewer-core/viewers/numpy';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import {
    assertSafeNumpyArchive,
    NUMPY_NPZ_MAX_ARCHIVE_BYTES
} from './numpyZipGuard';
import { createNumpyParserWorker } from './numpyWorkerFactory';

export type NumpyViewerHandle = ViewerHandle;

interface NumpyParserWorkerRequest {
    id: number;
    fileName: string;
    buffer: ArrayBuffer;
    byteOffset: number;
    byteLength: number;
    archive: boolean;
}

type NumpyParserWorkerResponse =
    | { id: number; model: NumpyDocument }
    | { id: number; error: string };

export interface NumpyParserWorkerLike {
    onmessage: ((event: MessageEvent<NumpyParserWorkerResponse>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage(message: NumpyParserWorkerRequest, transfer: Transferable[]): void;
    terminate(): void;
}

export type NumpyParserWorkerFactory = () => NumpyParserWorkerLike;

let workerRequestId = 0;

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
}

function readBlobArrayBuffer(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    // FileReader is used in the browser because Blob.arrayBuffer() has no
    // cancellation hook. The fallback keeps lightweight test/file shims usable.
    if (typeof FileReader === 'undefined' || !(blob instanceof Blob)) {
        return blob.arrayBuffer().then((buffer) => {
            if (signal?.aborted) throw abortError(signal);
            return buffer;
        });
    }
    return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onSignalAbort);
            callback();
        };
        const onSignalAbort = (): void => {
            if (reader.readyState === FileReader.LOADING) reader.abort();
            finish(() => reject(signal ? abortError(signal) : new DOMException(
                'The operation was aborted.',
                'AbortError'
            )));
        };
        signal?.addEventListener('abort', onSignalAbort, { once: true });
        reader.onload = (): void => finish(() => {
            if (reader.result instanceof ArrayBuffer) resolve(reader.result);
            else reject(new Error('The NumPy file could not be read as bytes.'));
        });
        reader.onerror = (): void => finish(() => reject(
            reader.error ?? new Error('The NumPy file could not be read.')
        ));
        reader.onabort = (): void => finish(() => reject(
            signal ? abortError(signal) : new DOMException('The operation was aborted.', 'AbortError')
        ));
        reader.readAsArrayBuffer(blob);
    });
}

/** Parse NPZ in a terminable worker after a no-inflate central-directory check. */
export function parseNumpyArchiveInWorker(
    data: Uint8Array,
    fileName: string,
    signal?: AbortSignal,
    workerFactory: NumpyParserWorkerFactory = createNumpyParserWorker
): Promise<NumpyDocument> {
    return parseNumpyInWorker(data, fileName, true, signal, workerFactory);
}

function parseNumpyFileInWorker(
    data: Uint8Array,
    fileName: string,
    signal?: AbortSignal,
    workerFactory: NumpyParserWorkerFactory = createNumpyParserWorker
): Promise<NumpyDocument> {
    return parseNumpyInWorker(data, fileName, false, signal, workerFactory);
}

function parseNumpyInWorker(
    data: Uint8Array,
    fileName: string,
    archive: boolean,
    signal: AbortSignal | undefined,
    workerFactory: NumpyParserWorkerFactory
): Promise<NumpyDocument> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (archive) assertSafeNumpyArchive(data);
    const worker = workerFactory();
    const id = ++workerRequestId;
    return new Promise<NumpyDocument>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            worker.terminate();
            callback();
        };
        const onAbort = (): void => finish(() => reject(
            signal ? abortError(signal) : new DOMException('The operation was aborted.', 'AbortError')
        ));
        signal?.addEventListener('abort', onAbort, { once: true });
        worker.onmessage = (event): void => {
            if (event.data.id !== id) return;
            if ('error' in event.data) {
                finish(() => reject(new Error(event.data.error)));
                return;
            }
            finish(() => resolve(event.data.model));
        };
        worker.onerror = (event): void => finish(() => reject(
            new Error(event.message || 'The NumPy parser worker failed.')
        ));
        const hasTransferableBuffer = data.buffer instanceof ArrayBuffer;
        const buffer = hasTransferableBuffer
            ? data.buffer
            : data.slice().buffer as ArrayBuffer;
        const byteOffset = hasTransferableBuffer ? data.byteOffset : 0;
        const byteLength = data.byteLength;
        worker.postMessage(
            { id, fileName, buffer, byteOffset, byteLength, archive },
            [buffer]
        );
    });
}

function context(): NumpyViewerContext {
    const chromeI18n = typeof chrome !== 'undefined' ? chrome.i18n : undefined;
    const locale = (typeof document !== 'undefined' ? document.documentElement.lang : '')
        || chromeI18n?.getUILanguage?.()
        || (typeof navigator !== 'undefined' ? navigator.language : '')
        || 'en';
    const ctx: NumpyViewerContext = {
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
                console[level === 'info' ? 'info' : level]('[omni-viewer numpy]', message)
        }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
        ctx.clipboard = { writeText: (text) => navigator.clipboard.writeText(text) };
    }
    return ctx;
}

/** Pass NPY decoding to the core; NPZ expansion stays in the bounded Worker. */
export async function mountNumpyViewer(
    file: File,
    container: HTMLElement,
    _fileHandle?: unknown,
    signal?: AbortSignal
): Promise<NumpyViewerHandle> {
    if (file.size > NUMPY_NPZ_MAX_ARCHIVE_BYTES) {
        throw new Error('The NumPy file exceeds the 512 MB file-size safety limit.');
    }
    const prefix = new Uint8Array(await readBlobArrayBuffer(file.slice(0, 6), signal));
    const hasNpyMagic = prefix.length >= 6
        && prefix[0] === 0x93
        && prefix[1] === 0x4e
        && prefix[2] === 0x55
        && prefix[3] === 0x4d
        && prefix[4] === 0x50
        && prefix[5] === 0x59;
    const hasZipMagic = prefix.length >= 2 && prefix[0] === 0x50 && prefix[1] === 0x4b;
    const hasNpzExtension = file.name.toLowerCase().endsWith('.npz');
    const data = new Uint8Array(await readBlobArrayBuffer(file, signal));
    return mountNumpyBytes(
        data,
        file.name,
        file.lastModified,
        container,
        signal,
        hasNpyMagic,
        hasNpzExtension || hasZipMagic
    );
}

async function mountNumpyBytes(
    data: Uint8Array,
    fileName: string,
    lastModified: number,
    container: HTMLElement,
    signal?: AbortSignal,
    knownNpy?: boolean,
    knownNpz?: boolean
): Promise<NumpyViewerHandle> {
    if (signal?.aborted) throw abortError(signal);
    const isNpy = knownNpy ?? (data.length >= 6
        && data[0] === 0x93
        && data[1] === 0x4e
        && data[2] === 0x55
        && data[3] === 0x4d
        && data[4] === 0x50
        && data[5] === 0x59);
    const isNpz = !isNpy && (
        knownNpz ?? (
            fileName.toLowerCase().endsWith('.npz') ||
            (data.length >= 2 && data[0] === 0x50 && data[1] === 0x4b)
        )
    );
    if (isNpy || isNpz) {
        const model = isNpz
            ? await parseNumpyArchiveInWorker(data, fileName, signal)
            : await parseNumpyFileInWorker(data, fileName, signal);
        return mountCoreNumpyDocument(model, fileName, container, context(), { signal });
    }
    return mountCoreNumpyViewer(
        {
            fileName,
            data,
            lastModified
        },
        container,
        context(),
        { signal }
    );
}

function createNumpyProvider(): ChromeViewerProvider {
    let handle: NumpyViewerHandle | undefined;
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
            let nextHandle: NumpyViewerHandle;
            try {
                nextHandle = await mountNumpyViewer(
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
    (item) => item.viewType === 'omni-viewer.numpyViewer'
);
if (registration) registration.createProvider = createNumpyProvider;

declare global {
    interface Window {
        __omniMountNumpy?: typeof mountNumpyViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountNumpy = mountNumpyViewer;

export async function readNumpyResponseBytesBounded(
    response: Response,
    limit = NUMPY_NPZ_MAX_ARCHIVE_BYTES
): Promise<Uint8Array> {
    const lengthHeader = response.headers.get('content-length');
    const declaredLength = lengthHeader && /^\d+$/.test(lengthHeader)
        ? Number(lengthHeader)
        : undefined;
    if (declaredLength !== undefined && declaredLength > limit) {
        await response.body?.cancel();
        throw new Error('The NumPy file exceeds the 512 MB file-size safety limit.');
    }
    if (!response.body) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > limit) {
            throw new Error('The NumPy file exceeds the 512 MB file-size safety limit.');
        }
        return new Uint8Array(buffer);
    }

    const reader = response.body.getReader();
    const initialCapacity = Math.min(declaredLength ?? 64 * 1024, 1024 * 1024);
    let output = new Uint8Array(Math.min(limit, Math.max(1, initialCapacity)));
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > limit) {
                await reader.cancel();
                throw new Error('The NumPy file exceeds the 512 MB file-size safety limit.');
            }
            if (total > output.byteLength) {
                const nextCapacity = Math.min(
                    limit,
                    Math.max(total, Math.max(1, output.byteLength * 2))
                );
                const next = new Uint8Array(nextCapacity);
                next.set(output);
                output = next;
            }
            output.set(value, total - value.byteLength);
        }
    } finally {
        reader.releaseLock();
    }
    return output.subarray(0, total);
}

export function numpyFileNameFromSource(src: string, fallbackName: string): string {
    try {
        const base = typeof window !== 'undefined'
            ? window.location.href
            : 'https://extension.invalid/';
        const segment = new URL(src, base).pathname.split('/').pop();
        if (!segment) return fallbackName;
        const decoded = decodeURIComponent(segment);
        if (!decoded) return fallbackName;
        if (decoded.length <= 256) return decoded;
        return `${decoded.slice(0, 223)}…${decoded.slice(-32)}`;
    } catch {
        return fallbackName;
    }
}

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="numpy"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await readNumpyResponseBytesBounded(response);
        const fallbackName = data.length >= 2 && data[0] === 0x50 && data[1] === 0x4b
            ? 'arrays.npz'
            : 'array.npy';
        const name = numpyFileNameFromSource(src, fallbackName);
        await mountNumpyBytes(data, name, 0, host);
    } catch (error) {
        host.textContent = `Failed to load NumPy data: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="numpy"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
