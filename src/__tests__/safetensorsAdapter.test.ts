// The core is pure ESM, so jest cannot `requireActual` it. The blob source is
// stubbed with a sentinel `read` instead: asserting that the exact same
// function object reaches the core proves the adapter forwards the core's
// source rather than rebuilding one, which is the part it owns.
const sentinelRead = jest.fn();
jest.mock('omni-viewer-core/viewers/safetensors', () => ({
    mountSafetensorsViewer: jest.fn(),
    createSafetensorsBlobSource: jest.fn((blob: Blob, fileName: string) => ({
        fileName,
        size: blob.size,
        read: sentinelRead
    }))
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.count ?? ''}`
    )
}));

import { mountSafetensorsViewer } from '../templates/safetensors/js/safetensorsViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/safetensors') as {
    mountSafetensorsViewer: jest.Mock;
    createSafetensorsBlobSource: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

const HEADER_JSON = '{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}';

/** 8-byte LE header length, then that many bytes of JSON, then the payload. */
function makeSafetensorsFile(name = 'model.safetensors'): File {
    // jest-environment-jsdom@29 exposes no global TextEncoder, and the header
    // is ASCII anyway.
    const header = Uint8Array.from(HEADER_JSON, (char) => char.charCodeAt(0));
    const bytes = new Uint8Array(8 + header.length + 4);
    new DataView(bytes.buffer).setUint32(0, header.length, true);
    bytes.set(header, 8);
    return new File([bytes], name, { lastModified: 1700000000000 });
}

describe('safetensors Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountSafetensorsViewer.mockResolvedValue({ dispose });
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
    });

    it('hands the core a lazy blob source instead of the file bytes', async () => {
        const file = makeSafetensorsFile();
        const container = document.createElement('div');

        const handle = await mountSafetensorsViewer(file, container);

        // The File itself is handed over for range reads — not its bytes.
        expect(core.createSafetensorsBlobSource).toHaveBeenCalledWith(file, 'model.safetensors');
        const source = core.mountSafetensorsViewer.mock.calls[0][0];
        expect(source).toEqual(
            expect.objectContaining({
                fileName: 'model.safetensors',
                size: file.size,
                lastModified: 1700000000000
            })
        );
        // Copying `lastModified` on must not drop the source's own `read`.
        expect(source.read).toBe(sentinelRead);
        // The whole point of the lazy source: no `data` for the core to parse.
        expect(source).not.toHaveProperty('data');
        expect(handle).toEqual({ dispose });
    });

    it('never materializes the file bytes while mounting', async () => {
        const file = makeSafetensorsFile();
        const arrayBuffer = jest.spyOn(file, 'arrayBuffer');

        await mountSafetensorsViewer(file, document.createElement('div'));

        // A multi-gigabyte model must not be read into memory to be viewed:
        // the core pulls the header through `read()` on its own.
        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(sentinelRead).not.toHaveBeenCalled();
    });

    it('prefers the app-selected document locale for core catalog fallbacks', async () => {
        await mountSafetensorsViewer(makeSafetensorsFile(), document.createElement('div'));
        const viewerContext = core.mountSafetensorsViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('safetensors.matchingRows', { count: 3 })).toBe(
            'ko-KR:safetensors.matchingRows:3'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'safetensors.matchingRows',
            { count: 3 }
        );
    });

    it('falls back to the browser UI language when the page pins no locale', async () => {
        // The standalone template page deliberately ships no `lang`, so this
        // is the path it takes.
        document.documentElement.lang = '';

        await mountSafetensorsViewer(makeSafetensorsFile(), document.createElement('div'));
        const viewerContext = core.mountSafetensorsViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('safetensors.matchingRows', { count: 1 })).toBe(
            'en-US:safetensors.matchingRows:1'
        );
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountSafetensorsViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.safetensorsViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            makeSafetensorsFile('slow.safetensors'),
            document.createElement('div')
        );
        await Promise.resolve();
        await Promise.resolve();
        provider.dispose?.();
        resolveMount({ dispose: lateDispose });
        await rendering;

        const options = core.mountSafetensorsViewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountSafetensorsViewer.mockRejectedValueOnce(new Error('header is not valid JSON'));

        await expect(
            mountSafetensorsViewer(
                new File(['not a model'], 'broken.safetensors'),
                document.createElement('div')
            )
        ).rejects.toThrow('header is not valid JSON');
    });
});
