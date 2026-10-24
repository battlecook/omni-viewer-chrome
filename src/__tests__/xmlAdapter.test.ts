jest.mock('omni-viewer-core/viewers/xml', () => ({
    mountXmlViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.count ?? ''}`
    )
}));

import { mountXmlViewer } from '../templates/xml/js/xmlViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/xml') as {
    mountXmlViewer: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

describe('XML Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountXmlViewer.mockResolvedValue({ dispose });
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
    });

    it('passes the document bytes to omni-viewer-core', async () => {
        // Parsing — well-formedness recovery, entity handling — belongs to the
        // core; the adapter hands over the raw bytes, BOM and all.
        const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x61, 0x2f, 0x3e]);
        const file = new File([bytes], 'pom.xml', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountXmlViewer(file, container);

        expect(core.mountXmlViewer).toHaveBeenCalledWith(
            {
                fileName: 'pom.xml',
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
        // The virtualized panes need a bounded host to scroll inside.
        expect(container.style.minHeight).toBe('560px');
    });

    it('prefers the app-selected document locale for core catalog fallbacks', async () => {
        await mountXmlViewer(new File(['<a/>'], 'pom.xml'), document.createElement('div'));
        const viewerContext = core.mountXmlViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('xml.stats.nodes', { count: 42 })).toBe(
            'ko-KR:xml.stats.nodes:42'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'xml.stats.nodes',
            { count: 42 }
        );
    });

    it('offers the clipboard the core lists as an optional service', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: jest.fn().mockResolvedValue(undefined) }
        });

        await mountXmlViewer(new File(['<a/>'], 'pom.xml'), document.createElement('div'));

        const viewerContext = core.mountXmlViewer.mock.calls[0][2];
        await viewerContext.clipboard.writeText('/project/modules/module[2]');
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/project/modules/module[2]');
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountXmlViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.xmlViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            {
                name: 'slow.xml',
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

        const options = core.mountXmlViewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountXmlViewer.mockRejectedValueOnce(new Error('input too large'));

        await expect(
            mountXmlViewer(
                new File(['<a>'], 'broken.xml'),
                document.createElement('div')
            )
        ).rejects.toThrow('input too large');
    });
});
