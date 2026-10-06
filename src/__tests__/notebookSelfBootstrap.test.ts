// The standalone page (`templates/notebook/notebookViewer.html?src=...`) is a
// separate entry into the adapter from the SPA's file intake, and it runs at
// module load. It lives in its own suite because the bootstrap mounts
// asynchronously the moment the module is required: sharing a module registry
// with the adapter suite lets that in-flight mount consume another test's
// queued mock.
jest.mock('omni-viewer-core/viewers/notebook', () => ({
    mountNotebookViewer: jest.fn()
}));
jest.mock('omni-viewer-core/viewers/notebook/self-loading', () => ({
    loadNotebookViewerDeps: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn((locale: string, key: string) => `${locale}:${key}`)
}));

const core = jest.requireMock('omni-viewer-core/viewers/notebook') as {
    mountNotebookViewer: jest.Mock;
};
const selfLoading = jest.requireMock('omni-viewer-core/viewers/notebook/self-loading') as {
    loadNotebookViewerDeps: jest.Mock;
};

const NOTEBOOK = '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}';

describe('notebook standalone page bootstrap', () => {
    it('keeps a malformed percent escape in the file name instead of failing', async () => {
        // `URLSearchParams` decodes the query once, so a singly-encoded src (a
        // URL pasted from the address bar) can leave a bare `%` in the last
        // segment. `decodeURIComponent` throws on that, which would discard a
        // notebook whose bytes have already arrived.
        core.mountNotebookViewer.mockResolvedValue({ dispose: jest.fn() });
        selfLoading.loadNotebookViewerDeps.mockResolvedValue({
            render: { parse: jest.fn() },
            createDOMPurify: jest.fn()
        });
        Object.assign(chrome, {
            i18n: { getMessage: jest.fn(() => ''), getUILanguage: jest.fn(() => 'en-US') },
            runtime: { getURL: jest.fn((path: string) => `chrome-extension://omni/${path}`) }
        });
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            blob: async () => new Blob([NOTEBOOK], { type: 'application/json' })
        });
        Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true });
        window.history.replaceState({}, '', '/?src=https://cdn.test/nb.ipynb%3Fv%3D100%25');
        document.body.innerHTML = '<main data-viewer="notebook"></main>';
        const host = document.querySelector<HTMLElement>('[data-viewer="notebook"]')!;

        // Required, not imported: the bootstrap reads the DOM and the query
        // string at load, so both have to be in place first.
        require('../templates/notebook/js/notebookViewer');
        // fetch -> blob -> arrayBuffer -> deps -> mount: several awaits deep.
        for (let tick = 0; tick < 10; tick += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(fetchMock).toHaveBeenCalledWith('https://cdn.test/nb.ipynb?v=100%');
        expect(core.mountNotebookViewer).toHaveBeenCalled();
        expect(core.mountNotebookViewer.mock.calls[0][0].fileName).toBe('nb.ipynb?v=100%');
        expect(host.textContent).not.toContain('Failed to load');
    });
});
