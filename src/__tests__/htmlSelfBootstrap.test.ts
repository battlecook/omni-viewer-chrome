jest.mock('omni-viewer-core/viewers/html', () => ({
    mountHtmlViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn((_locale: string, key: string) => key)
}));

describe('HTML standalone page bootstrap', () => {
    let core: { mountHtmlViewer: jest.Mock };
    let fetchMock: jest.Mock;

    beforeEach(() => {
        jest.resetModules();
        core = jest.requireMock('omni-viewer-core/viewers/html');
        core.mountHtmlViewer.mockResolvedValue({ dispose: jest.fn() });
        fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            blob: async () => new Blob(['<p style="width:100%">hello</p>'], { type: 'text/html' })
        });
        Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true });
        document.body.innerHTML = '<main data-viewer="html"></main>';
    });

    afterEach(() => {
        document.body.replaceChildren();
        window.history.replaceState({}, '', '/');
    });

    it.each([
        ['data:text/html,<p style="width:100%">hello</p>', 'document.html'],
        ['blob:https://viewer.test/1234-5678', 'document.html'],
        ['https://cdn.test/report%20Q1.html?progress=100%', 'report Q1.html'],
        ['https://cdn.test/report100%.html', 'report100%.html'],
        ['reports/report%20Q1.htm', 'report Q1.htm']
    ])('mounts fetched HTML from %s with a safe display name', async (src, name) => {
        window.history.replaceState({}, '', `/?${new URLSearchParams({ src })}`);

        require('../templates/html/js/htmlViewer');
        for (let tick = 0; tick < 5; tick += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        expect(fetchMock).toHaveBeenCalledWith(src);
        expect(core.mountHtmlViewer).toHaveBeenCalledTimes(1);
        expect(core.mountHtmlViewer.mock.calls[0][0].fileName).toBe(name);
        expect(document.body.textContent).not.toContain('Failed to load');
    });
});
