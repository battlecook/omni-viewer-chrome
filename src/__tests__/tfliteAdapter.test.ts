jest.mock('omni-viewer-core/viewers/tflite', () => ({
    mountTfliteViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.version ?? ''}`
    )
}));

import { mountTfliteViewer } from '../templates/tflite/js/tfliteViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/tflite') as {
    mountTfliteViewer: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

describe('TFLite Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountTfliteViewer.mockResolvedValue({ dispose });
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
    });

    it('passes the TFL3 file bytes to omni-viewer-core', async () => {
        const bytes = new Uint8Array([0x14, 0, 0, 0, 0x54, 0x46, 0x4c, 0x33]);
        const file = new File([bytes], 'tiny.tflite', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountTfliteViewer(file, container);

        expect(core.mountTfliteViewer).toHaveBeenCalledWith(
            {
                fileName: 'tiny.tflite',
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

    it('prefers the app-selected document locale for core catalog fallbacks', async () => {
        await mountTfliteViewer(new File(['model'], 'model.tflite'), document.createElement('div'));
        const viewerContext = core.mountTfliteViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('tflite.runtime', { version: 7 })).toBe(
            'ko-KR:tflite.runtime:7'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'tflite.runtime',
            { version: 7 }
        );
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountTfliteViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.tfliteViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            {
                name: 'slow.tflite',
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

        const options = core.mountTfliteViewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountTfliteViewer.mockRejectedValueOnce(new Error('parse failed'));

        await expect(
            mountTfliteViewer(
                new File(['not a flatbuffer'], 'broken.tflite'),
                document.createElement('div')
            )
        ).rejects.toThrow('parse failed');
    });
});
