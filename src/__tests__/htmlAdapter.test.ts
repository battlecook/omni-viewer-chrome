jest.mock('omni-viewer-core/viewers/html', () => ({
    mountHtmlViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.count ?? ''}`
    )
}));

import { mountHtmlViewer } from '../templates/html/js/htmlViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/html') as {
    mountHtmlViewer: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

describe('HTML Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountHtmlViewer.mockResolvedValue({ dispose });
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
    });

    it('passes the document bytes to omni-viewer-core', async () => {
        // The core owns decoding and preview isolation; preserve the raw BOM bytes.
        const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x61, 0x2f, 0x3e]);
        const file = new File([bytes], 'index.html', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountHtmlViewer(file, container);

        expect(core.mountHtmlViewer).toHaveBeenCalledWith(
            {
                fileName: 'index.html',
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
        // Preview and source panes need a bounded host to scroll inside.
        expect(container.style.minHeight).toBe('560px');
    });

    it('prefers the app-selected document locale for core catalog fallbacks', async () => {
        await mountHtmlViewer(new File(['<a/>'], 'index.html'), document.createElement('div'));
        const viewerContext = core.mountHtmlViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('html.tooLarge', { count: 42 })).toBe(
            'ko-KR:html.tooLarge:42'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'html.tooLarge',
            { count: 42 }
        );
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountHtmlViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.htmlViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            {
                name: 'slow.html',
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

        const options = core.mountHtmlViewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountHtmlViewer.mockRejectedValueOnce(new Error('input too large'));

        await expect(
            mountHtmlViewer(
                new File(['<a>'], 'broken.html'),
                document.createElement('div')
            )
        ).rejects.toThrow('input too large');
    });

    it('keeps the new viewer when an earlier mount finishes and disposes late', async () => {
        let resolveFirst!: (handle: { dispose(): void }) => void;
        let firstContainer!: HTMLElement;
        core.mountHtmlViewer.mockImplementationOnce((input, container: HTMLElement) => {
            firstContainer = container;
            container.textContent = input.fileName;
            return new Promise((resolve) => { resolveFirst = resolve; });
        }).mockImplementationOnce((input, container: HTMLElement) => {
            container.textContent = input.fileName;
            return Promise.resolve({ dispose: () => container.replaceChildren() });
        });
        const provider = VIEWER_REGISTRATIONS.find(
            (item) => item.slug === 'html'
        )!.createProvider();
        const container = document.createElement('div');
        const firstRender = provider.render(new File(['<p>A</p>'], 'first.html'), container);
        // Let the first mount acquire its DOM, but keep its handle pending.
        await Promise.resolve();
        await Promise.resolve();
        await provider.render(new File(['<p>B</p>'], 'second.html'), container);
        resolveFirst({ dispose: () => firstContainer.replaceChildren() });
        await firstRender;

        expect(container.textContent).toBe('second.html');
        expect(core.mountHtmlViewer.mock.calls[0][1])
            .not.toBe(core.mountHtmlViewer.mock.calls[1][1]);
        provider.dispose?.();
        expect(container.childNodes).toHaveLength(0);
    });
});
