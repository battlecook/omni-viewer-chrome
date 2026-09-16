jest.mock('omni-viewer-core/viewers/numpy', () => ({
    mountNumpyViewer: jest.fn(),
    mountNumpyDocument: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.axis ?? ''}`
    )
}));
jest.mock('../templates/numpy/js/numpyWorkerFactory', () => ({
    createNumpyParserWorker: jest.fn()
}));

import JSZip from 'jszip';
import {
    mountNumpyViewer,
    numpyFileNameFromSource,
    parseNumpyArchiveInWorker,
    readNumpyResponseBytesBounded,
    type NumpyParserWorkerLike
} from '../templates/numpy/js/numpyViewer';
import { NUMPY_NPZ_MAX_ARCHIVE_BYTES } from '../templates/numpy/js/numpyZipGuard';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/numpy') as {
    mountNumpyViewer: jest.Mock;
    mountNumpyDocument: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};
const workerFactory = jest.requireMock('../templates/numpy/js/numpyWorkerFactory') as {
    createNumpyParserWorker: jest.Mock;
};

const npzModel = {
    format: 'NumPy NPZ',
    title: 'NumPy array archive',
    fileSize: '1 KB',
    arrays: [],
    summary: [],
    tables: [],
    warnings: []
};
const npyModel = {
    ...npzModel,
    format: 'NumPy NPY',
    title: 'NumPy array'
};

function fakeWorker(model = npzModel): NumpyParserWorkerLike & { terminate: jest.Mock } {
    const worker: NumpyParserWorkerLike & { terminate: jest.Mock } = {
        onmessage: null,
        onerror: null,
        postMessage: jest.fn((request) => {
            queueMicrotask(() => worker.onmessage?.({
                data: { id: request.id, model }
            } as MessageEvent));
        }),
        terminate: jest.fn()
    };
    return worker;
}

async function makeNpz(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file('array.npy', new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]));
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function immediateFile(contents: string, name: string): File {
    const bytes = Uint8Array.from(contents, (character) => character.charCodeAt(0));
    return {
        name,
        size: bytes.byteLength,
        lastModified: 1700000000000,
        slice: (start = 0, end = bytes.byteLength) => {
            const part = bytes.slice(start, end);
            return { arrayBuffer: () => Promise.resolve(part.buffer) } as Blob;
        },
        arrayBuffer: () => Promise.resolve(bytes.slice().buffer)
    } as unknown as File;
}

describe('NumPy Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountNumpyViewer.mockResolvedValue({ dispose });
        core.mountNumpyDocument.mockReturnValue({ dispose });
        workerFactory.createNumpyParserWorker.mockImplementation(() => fakeWorker());
        document.documentElement.lang = 'ko-KR';
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
    });

    it('parses NPY in a worker and mounts the resulting core document', async () => {
        const name = 'array.npy';
        const bytes = new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);
        const worker = fakeWorker(npyModel);
        workerFactory.createNumpyParserWorker.mockReturnValueOnce(worker);
        const file = new File([bytes], name, { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountNumpyViewer(file, container);

        expect(core.mountNumpyViewer).not.toHaveBeenCalled();
        expect(core.mountNumpyDocument).toHaveBeenCalledWith(
            npyModel,
            name,
            container,
            expect.objectContaining({ i18n: expect.any(Object) }),
            { signal: undefined }
        );
        expect(worker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ fileName: name, archive: false }),
            expect.any(Array)
        );
        expect(handle).toEqual({ dispose });
    });

    it('rejects an oversized ZIP-magic file before reading its full body', async () => {
        const arrayBuffer = jest.fn();
        const file = {
            name: 'disguised.npy',
            size: NUMPY_NPZ_MAX_ARCHIVE_BYTES + 1,
            lastModified: 0,
            slice: jest.fn(() => new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])])),
            arrayBuffer
        } as unknown as File;

        await expect(mountNumpyViewer(file, document.createElement('div'))).rejects.toThrow(
            '512 MB file-size safety limit'
        );
        expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it('cancels a browser file read when the external signal aborts', async () => {
        const controller = new AbortController();
        const mounting = mountNumpyViewer(
            new File([new Uint8Array(1024)], 'cancelled.npy'),
            document.createElement('div'),
            undefined,
            controller.signal
        );

        controller.abort(new DOMException('cancelled', 'AbortError'));

        await expect(mounting).rejects.toMatchObject({ name: 'AbortError' });
        expect(core.mountNumpyViewer).not.toHaveBeenCalled();
        expect(core.mountNumpyDocument).not.toHaveBeenCalled();
    });

    it('cancels a remote response stream as soon as it exceeds the size limit', async () => {
        const cancel = jest.fn().mockResolvedValue(undefined);
        const releaseLock = jest.fn();
        const read = jest.fn()
            .mockResolvedValueOnce({ done: false, value: new Uint8Array(6) })
            .mockResolvedValueOnce({ done: false, value: new Uint8Array(6) });
        const response = {
            headers: { get: jest.fn(() => null) },
            body: { getReader: () => ({ read, cancel, releaseLock }) }
        } as unknown as Response;

        await expect(readNumpyResponseBytesBounded(response, 10)).rejects.toThrow(
            '512 MB file-size safety limit'
        );
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(releaseLock).toHaveBeenCalledTimes(1);
    });

    it('does not preallocate an untrusted large Content-Length', async () => {
        const releaseLock = jest.fn();
        const read = jest.fn()
            .mockResolvedValueOnce({ done: false, value: new Uint8Array([7]) })
            .mockResolvedValueOnce({ done: true, value: undefined });
        const response = {
            headers: { get: jest.fn(() => String(10 * 1024 * 1024)) },
            body: { getReader: () => ({ read, cancel: jest.fn(), releaseLock }) }
        } as unknown as Response;

        const bytes = await readNumpyResponseBytesBounded(response, 10 * 1024 * 1024);

        expect([...bytes]).toEqual([7]);
        expect(bytes.buffer.byteLength).toBeLessThanOrEqual(1024 * 1024);
        expect(releaseLock).toHaveBeenCalledTimes(1);
    });

    it('extracts a standalone filename without leaking signed URL parameters', () => {
        expect(numpyFileNameFromSource(
            'https://storage.example/arrays.npz?X-Goog-Signature=secret#fragment',
            'fallback.npz'
        )).toBe('arrays.npz');
        expect(numpyFileNameFromSource(
            'https://storage.example/broken%.npy',
            'array.npy'
        )).toBe('array.npy');
    });

    it('parses NPZ in a worker and mounts the resulting core document', async () => {
        const bytes = await makeNpz();
        const worker = fakeWorker();
        workerFactory.createNumpyParserWorker.mockReturnValueOnce(worker);
        const file = new File([bytes], 'arrays.npz', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountNumpyViewer(file, container);

        expect(core.mountNumpyViewer).not.toHaveBeenCalled();
        expect(core.mountNumpyDocument).toHaveBeenCalledWith(
            npzModel,
            'arrays.npz',
            container,
            expect.objectContaining({ i18n: expect.any(Object) }),
            { signal: undefined }
        );
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(handle).toEqual({ dispose });
    });

    it('terminates an in-flight NPZ worker when aborted', async () => {
        const bytes = await makeNpz();
        const worker = fakeWorker();
        (worker.postMessage as jest.Mock).mockImplementation(() => undefined);
        const controller = new AbortController();
        const parsing = parseNumpyArchiveInWorker(
            bytes,
            'slow.npz',
            controller.signal,
            () => worker
        );

        controller.abort(new DOMException('cancelled', 'AbortError'));

        await expect(parsing).rejects.toMatchObject({ name: 'AbortError' });
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it('uses the app-selected document locale for core catalog fallbacks', async () => {
        await mountNumpyViewer(new File(['data'], 'array.npy'), document.createElement('div'));
        const viewerContext = core.mountNumpyViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('numpy.axis', { axis: 2 })).toBe('ko-KR:numpy.axis:2');
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'numpy.axis',
            { axis: 2 }
        );
    });

    it('forwards an external abort signal to omni-viewer-core', async () => {
        const controller = new AbortController();
        await mountNumpyViewer(
            new File(['data'], 'array.npy'),
            document.createElement('div'),
            undefined,
            controller.signal
        );

        expect(core.mountNumpyViewer.mock.calls[0][3]).toEqual({ signal: controller.signal });
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountNumpyViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.numpyViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            immediateFile('slow', 'slow.npy'),
            document.createElement('div')
        );
        for (let index = 0; index < 5; index += 1) await Promise.resolve();
        provider.dispose?.();
        resolveMount({ dispose: lateDispose });
        await rendering;

        const options = core.mountNumpyViewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('disposes a stale mount when a newer provider render wins', async () => {
        let resolveFirst!: (handle: { dispose: jest.Mock }) => void;
        const staleDispose = jest.fn();
        const currentDispose = jest.fn();
        core.mountNumpyViewer
            .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
            .mockResolvedValueOnce({ dispose: currentDispose });
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.numpyViewer'
        );
        const provider = registration!.createProvider();
        const container = document.createElement('div');
        const first = provider.render(immediateFile('first', 'first.npy'), container);
        for (let index = 0; index < 5; index += 1) await Promise.resolve();
        await provider.render(immediateFile('second', 'second.npy'), container);
        resolveFirst({ dispose: staleDispose });
        await first;

        expect(staleDispose).toHaveBeenCalledTimes(1);
        expect(currentDispose).not.toHaveBeenCalled();
        provider.dispose?.();
        expect(currentDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountNumpyViewer.mockRejectedValueOnce(new Error('parse failed'));

        await expect(
            mountNumpyViewer(immediateFile('bad', 'broken.npy'), document.createElement('div'))
        ).rejects.toThrow('parse failed');
    });
});
