jest.mock('omni-viewer-core/viewers/keras', () => ({
    mountKerasViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.version ?? ''}`
    )
}));

import { mountKerasViewer } from '../templates/keras/js/kerasViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/keras') as {
    mountKerasViewer: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

describe('Keras Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountKerasViewer.mockResolvedValue({ dispose });
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
    });

    it('passes the archive bytes to omni-viewer-core', async () => {
        // "PK\x03\x04" — the ZIP header a .keras model opens with.
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
        const file = new File([bytes], 'mnist.keras', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountKerasViewer(file, container);

        expect(core.mountKerasViewer).toHaveBeenCalledWith(
            {
                fileName: 'mnist.keras',
                data: bytes,
                lastModified: 1700000000000
            },
            container,
            expect.objectContaining({
                i18n: expect.objectContaining({ t: expect.any(Function) })
            }),
            { signal: undefined }
        );
        expect(handle).toEqual({ dispose });
    });

    // Routing for such a file is covered in fileUtils.test.ts; here the point
    // is only that the adapter forwards non-ZIP bytes untouched, since the
    // core reads the legacy HDF5 save format off the same entry point.
    it('forwards legacy Keras HDF5 bytes unchanged', async () => {
        const bytes = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);

        await mountKerasViewer(
            new File([bytes], 'legacy.h5', { lastModified: 1700000000000 }),
            document.createElement('div')
        );

        expect(core.mountKerasViewer.mock.calls[0][0]).toEqual({
            fileName: 'legacy.h5',
            data: bytes,
            lastModified: 1700000000000
        });
    });

    it('prefers the app-selected document locale for core catalog fallbacks', async () => {
        await mountKerasViewer(new File(['model'], 'model.keras'), document.createElement('div'));
        const viewerContext = core.mountKerasViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('keras.version', { version: 3 })).toBe(
            'ko-KR:keras.version:3'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'keras.version',
            { version: 3 }
        );
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountKerasViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.kerasViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            {
                name: 'slow.keras',
                lastModified: 1700000000000,
                arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8))
            } as unknown as File,
            document.createElement('div')
        );
        await Promise.resolve();
        await Promise.resolve();
        provider.dispose?.();
        resolveMount({ dispose: lateDispose });
        await rendering;

        const options = core.mountKerasViewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountKerasViewer.mockRejectedValueOnce(new Error('parse failed'));

        await expect(
            mountKerasViewer(
                new File(['not an archive'], 'broken.keras'),
                document.createElement('div')
            )
        ).rejects.toThrow('parse failed');
    });
});
