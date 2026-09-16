jest.mock('omni-viewer-core/viewers/coreml', () => ({
    mountCoremlViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.version ?? ''}`
    )
}));

import { mountCoremlViewer } from '../templates/coreml/js/coremlViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/coreml') as {
    mountCoremlViewer: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

describe('Core ML Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountCoremlViewer.mockResolvedValue({ dispose });
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
    });

    it('passes the specification bytes to omni-viewer-core', async () => {
        // Field 1 (specificationVersion) = 7 — how a .mlmodel protobuf opens.
        const bytes = new Uint8Array([0x08, 0x07, 0x12, 0x00, 0, 0, 0, 0]);
        const file = new File([bytes], 'sentiment.mlmodel', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountCoremlViewer(file, container);

        expect(core.mountCoremlViewer).toHaveBeenCalledWith(
            {
                fileName: 'sentiment.mlmodel',
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

    it('hands a zipped .mlpackage bundle to the same core viewer', async () => {
        // "PK\x03\x04" — an .mlpackage reaches the browser as its zipped bundle.
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

        await mountCoremlViewer(
            new File([bytes], 'resnet.mlpackage', { lastModified: 1700000000000 }),
            document.createElement('div')
        );

        expect(core.mountCoremlViewer.mock.calls[0][0]).toEqual({
            fileName: 'resnet.mlpackage',
            data: bytes,
            lastModified: 1700000000000
        });
    });

    it('prefers the app-selected document locale for core catalog fallbacks', async () => {
        await mountCoremlViewer(
            new File(['model'], 'model.mlmodel'),
            document.createElement('div')
        );
        const viewerContext = core.mountCoremlViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('coreml.version', { version: 7 })).toBe(
            'ko-KR:coreml.version:7'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'coreml.version',
            { version: 7 }
        );
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountCoremlViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.coremlViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            {
                name: 'slow.mlpackage',
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

        const options = core.mountCoremlViewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountCoremlViewer.mockRejectedValueOnce(new Error('parse failed'));

        await expect(
            mountCoremlViewer(
                new File(['not a model'], 'broken.mlmodel'),
                document.createElement('div')
            )
        ).rejects.toThrow('parse failed');
    });
});
