jest.mock('omni-viewer-core/viewers/pt2', () => ({
    mountPt2Viewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.count ?? ''}`
    )
}));

import { mountPt2Viewer } from '../templates/pt2/js/pt2Viewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/pt2') as {
    mountPt2Viewer: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

describe('PyTorch ExportedProgram Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountPt2Viewer.mockResolvedValue({ dispose });
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
    });

    it('passes the package bytes to omni-viewer-core', async () => {
        // A ZIP local file header is all the adapter needs to hand over — the
        // archive walk itself belongs to the core parser.
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
        const file = new File([bytes], 'resnet.pt2', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountPt2Viewer(file, container);

        expect(core.mountPt2Viewer).toHaveBeenCalledWith(
            {
                fileName: 'resnet.pt2',
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
        await mountPt2Viewer(new File(['pkg'], 'model.pt2'), document.createElement('div'));
        const viewerContext = core.mountPt2Viewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('pt2.graph.nodes', { count: 42 })).toBe(
            'ko-KR:pt2.graph.nodes:42'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'pt2.graph.nodes',
            { count: 42 }
        );
    });

    it('offers the clipboard the core lists as an optional service', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: jest.fn().mockResolvedValue(undefined) }
        });

        await mountPt2Viewer(new File(['pkg'], 'model.pt2'), document.createElement('div'));

        const viewerContext = core.mountPt2Viewer.mock.calls[0][2];
        await viewerContext.clipboard.writeText('aten.addmm.default');
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('aten.addmm.default');
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountPt2Viewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.pt2Viewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            {
                name: 'slow.pt2',
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

        const options = core.mountPt2Viewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountPt2Viewer.mockRejectedValueOnce(new Error('archive unreadable'));

        await expect(
            mountPt2Viewer(
                new File(['not a zip'], 'broken.pt2'),
                document.createElement('div')
            )
        ).rejects.toThrow('archive unreadable');
    });
});
