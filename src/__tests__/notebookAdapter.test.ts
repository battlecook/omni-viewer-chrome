jest.mock('omni-viewer-core/viewers/notebook', () => ({
    mountNotebookViewer: jest.fn()
}));
jest.mock('omni-viewer-core/viewers/notebook/self-loading', () => ({
    loadNotebookViewerDeps: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.cells ?? ''}`
    )
}));

import { mountNotebookViewer } from '../templates/notebook/js/notebookViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/notebook') as {
    mountNotebookViewer: jest.Mock;
};
const selfLoading = jest.requireMock('omni-viewer-core/viewers/notebook/self-loading') as {
    loadNotebookViewerDeps: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

const NOTEBOOK = '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}';
const DEPS = { render: { parse: jest.fn() }, createDOMPurify: jest.fn() };

describe('Jupyter Notebook Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountNotebookViewer.mockResolvedValue({ dispose });
        selfLoading.loadNotebookViewerDeps.mockResolvedValue(DEPS);
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            },
            runtime: {
                getURL: jest.fn((path: string) => `chrome-extension://omni/${path}`)
            }
        });
        document.documentElement.lang = 'ko-KR';
        document.head.innerHTML = '';
    });

    it('passes the notebook bytes and the loaded renderers to omni-viewer-core', async () => {
        // jest-environment-jsdom@29 ships no TextEncoder global, so the
        // fixture bytes are built by hand (the notebook is pure ASCII).
        const bytes = Uint8Array.from(NOTEBOOK, (char) => char.charCodeAt(0));
        const file = new File([bytes], 'analysis.ipynb', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountNotebookViewer(file, container);

        expect(core.mountNotebookViewer).toHaveBeenCalledWith(
            {
                fileName: 'analysis.ipynb',
                data: bytes,
                lastModified: 1700000000000
            },
            container,
            expect.objectContaining({
                i18n: expect.objectContaining({ t: expect.any(Function) }),
                navigation: expect.objectContaining({ openExternalUrl: expect.any(Function) })
            }),
            DEPS,
            {}
        );
        expect(handle).toEqual({ dispose });
    });

    it('bounds the container so the cell list scrolls internally', async () => {
        // The core layout is `height: 100%` with the cell list as the only
        // `overflow: auto` pane, so an unbounded container resolves to `auto`
        // and the panel grows to the whole notebook instead of scrolling.
        const container = document.createElement('div');
        await mountNotebookViewer(new File([NOTEBOOK], 'analysis.ipynb'), container);

        // jsdom's CSSOM silently drops `min()`, so only the floor is
        // assertable here; the bound matches the json/toml/pdf/har adapters.
        expect(container.style.minHeight).toBe('560px');
    });

    it('loads katex.min.css into the document and the viewer shadow root', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const shadow = container.attachShadow({ mode: 'open' });

        await mountNotebookViewer(new File([NOTEBOOK], 'math.ipynb'), container);

        for (const root of [document.head, shadow]) {
            const link = root.querySelector('link[data-omni-katex]') as HTMLLinkElement | null;
            expect(link?.href).toBe('chrome-extension://omni/assets/katex/katex.min.css');
        }
    });

    it('prefers the app-selected document locale for core catalog fallbacks', async () => {
        await mountNotebookViewer(
            new File([NOTEBOOK], 'analysis.ipynb'),
            document.createElement('div')
        );
        const viewerContext = core.mountNotebookViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('notebook.summary', { cells: 12 })).toBe(
            'ko-KR:notebook.summary:12'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'notebook.summary',
            { cells: 12 }
        );
    });

    it('leaves documentAssets unwired, so relative image paths stay unresolved', async () => {
        await mountNotebookViewer(
            new File([NOTEBOOK], 'analysis.ipynb'),
            document.createElement('div')
        );
        const viewerContext = core.mountNotebookViewer.mock.calls[0][2];

        expect(viewerContext.documentAssets).toBeUndefined();
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountNotebookViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.notebookViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            {
                name: 'slow.ipynb',
                lastModified: 1700000000000,
                arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8))
            } as unknown as File,
            document.createElement('div')
        );
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        provider.dispose?.();
        resolveMount({ dispose: lateDispose });
        await rendering;

        const options = core.mountNotebookViewer.mock.calls[0][4];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountNotebookViewer.mockRejectedValueOnce(
            new Error('Invalid Jupyter Notebook document.')
        );

        await expect(
            mountNotebookViewer(
                new File(['not json'], 'broken.ipynb'),
                document.createElement('div')
            )
        ).rejects.toThrow('Invalid Jupyter Notebook document.');
    });
});
