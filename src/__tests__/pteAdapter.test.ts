jest.mock('omni-viewer-core/viewers/pte', () => ({
    mountPteViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.version ?? ''}`
    )
}));

import { mountPteViewer } from '../templates/pte/js/pteViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/pte') as {
    mountPteViewer: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

describe('ExecuTorch Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountPteViewer.mockResolvedValue({ dispose });
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
    });

    it('passes the ET12 file bytes to omni-viewer-core', async () => {
        const bytes = new Uint8Array([0x14, 0, 0, 0, 0x45, 0x54, 0x31, 0x32]);
        const file = new File([bytes], 'tiny.pte', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountPteViewer(file, container);

        expect(core.mountPteViewer).toHaveBeenCalledWith(
            {
                fileName: 'tiny.pte',
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
        await mountPteViewer(new File(['model'], 'model.pte'), document.createElement('div'));
        const viewerContext = core.mountPteViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('pte.schema', { version: 7 })).toBe(
            'ko-KR:pte.schema:7'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'pte.schema',
            { version: 7 }
        );
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountPteViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.pteViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            {
                name: 'slow.pte',
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

        const options = core.mountPteViewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountPteViewer.mockRejectedValueOnce(new Error('parse failed'));

        await expect(
            mountPteViewer(
                new File(['not a flatbuffer'], 'broken.pte'),
                document.createElement('div')
            )
        ).rejects.toThrow('parse failed');
    });
});
