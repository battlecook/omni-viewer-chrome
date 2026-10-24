jest.mock('omni-viewer-core/viewers/epub', () => ({
    mountEpubViewer: jest.fn()
}));
jest.mock('omni-viewer-core/viewers/epub/self-loading', () => ({
    loadEpubViewerDeps: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.count ?? ''}`
    )
}));

import { mountEpubViewer } from '../templates/epub/js/epubViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/epub') as {
    mountEpubViewer: jest.Mock;
};
const selfLoading = jest.requireMock('omni-viewer-core/viewers/epub/self-loading') as {
    loadEpubViewerDeps: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

describe('EPUB Chrome adapter', () => {
    const dispose = jest.fn();
    const deps = { createDOMPurify: jest.fn() };

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountEpubViewer.mockResolvedValue({ dispose, currentIndex: () => 0, goTo: jest.fn() });
        selfLoading.loadEpubViewerDeps.mockResolvedValue(deps);
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
    });

    it('passes the book bytes and the sanitizer to omni-viewer-core', async () => {
        // A ZIP local file header is all the adapter needs to hand over — the
        // OCF walk and on-demand inflation belong to the core parser.
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
        const file = new File([bytes], 'alice.epub', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountEpubViewer(file, container);

        expect(core.mountEpubViewer).toHaveBeenCalledWith(
            {
                fileName: 'alice.epub',
                data: bytes,
                lastModified: 1700000000000
            },
            container,
            expect.objectContaining({
                i18n: expect.objectContaining({ t: expect.any(Function) })
            }),
            deps,
            { signal: undefined }
        );
        expect(handle).toEqual(expect.objectContaining({ dispose }));
        // The reading pane scrolls inside the host, so the host is bounded.
        expect(container.style.minHeight).toBe('560px');
    });

    it('prefers the app-selected document locale for core catalog fallbacks', async () => {
        await mountEpubViewer(new File(['pkg'], 'book.epub'), document.createElement('div'));
        const viewerContext = core.mountEpubViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('epub.chapters', { count: 12 })).toBe(
            'ko-KR:epub.chapters:12'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'epub.chapters',
            { count: 12 }
        );
    });

    it('opens external links in a new tab through the navigation service', async () => {
        const open = jest.spyOn(window, 'open').mockImplementation(() => null);

        await mountEpubViewer(new File(['pkg'], 'book.epub'), document.createElement('div'));
        const viewerContext = core.mountEpubViewer.mock.calls[0][2];
        await viewerContext.navigation.openExternalUrl('https://www.gutenberg.org/');

        expect(open).toHaveBeenCalledWith('https://www.gutenberg.org/', '_blank', 'noopener,noreferrer');
        open.mockRestore();
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountEpubViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.epubViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            {
                name: 'slow.epub',
                lastModified: 1700000000000,
                arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8))
            } as unknown as File,
            document.createElement('div')
        );
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        expect(core.mountEpubViewer).toHaveBeenCalled();
        provider.dispose?.();
        resolveMount({ dispose: lateDispose });
        await rendering;

        const options = core.mountEpubViewer.mock.calls[0][4];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountEpubViewer.mockRejectedValueOnce(new Error('container.xml missing'));

        await expect(
            mountEpubViewer(
                new File(['not a zip'], 'broken.epub'),
                document.createElement('div')
            )
        ).rejects.toThrow('container.xml missing');
    });
});
