// Adapter-level tests for the LaTeX viewer.
//
// The rendering itself belongs to omni-viewer-core (and is tested there), so
// the core mount is mocked and these tests pin what the *Chrome adapter* owns:
// the KaTeX stylesheet/fonts, the deps-as-mount-option injection contract, and
// the host services handed to the core.

// jest-environment-jsdom@29 does not expose TextEncoder as a global.
import { TextEncoder as NodeTextEncoder } from 'util';

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof NodeTextEncoder }).TextEncoder = NodeTextEncoder;
}

const mountCoreLatexViewer = jest.fn();
const loadLatexViewerDeps = jest.fn();

jest.mock('omni-viewer-core/viewers/latex', () => ({
    mountLatexViewer: (...args: unknown[]) => mountCoreLatexViewer(...args)
}));
jest.mock('omni-viewer-core/viewers/latex/self-loading', () => ({
    loadLatexViewerDeps: () => loadLatexViewerDeps()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveCatalogMessage: (key: string) => key
}));

import { mountLatexViewer } from '../templates/latex/js/latexViewer';
import { KATEX_STYLESHEET_PATH } from '../utils/katexAssets';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

interface CoreContext {
    i18n: { t(key: string, args?: Record<string, string | number>): string };
    logger: { log(level: string, message: string): void };
    clipboard?: { writeText(text: string): Promise<void> };
    navigation?: { openExternalUrl(url: string): Promise<void> };
    save?: { saveFile(name: string, data: Uint8Array, mimeType: string): Promise<void> };
    writeback?: { write(data: Uint8Array): Promise<void> };
}

const SOURCE = '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\n\\end{document}\n';

function latexFile(source = SOURCE, name = 'paper.tex'): File {
    const bytes = new TextEncoder().encode(source);
    return {
        name,
        size: bytes.byteLength,
        type: 'text/x-tex',
        lastModified: 1_700_000_000_000,
        arrayBuffer: jest.fn(async () => bytes.buffer)
    } as unknown as File;
}

/** The core mounts into an open shadow root; reproduce that here so the
 *  adapter's stylesheet injection has the same target it has in production. */
function coreMountSpy(): jest.Mock {
    return mountCoreLatexViewer.mockImplementation(async (_input, container: HTMLElement) => {
        const root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
        root.append(document.createElement('section'));
        return { dispose: jest.fn() };
    });
}

function katexLinks(root: ParentNode): HTMLLinkElement[] {
    return Array.from(root.querySelectorAll<HTMLLinkElement>('link[data-omni-katex]'));
}

describe('LaTeX viewer adapter', () => {
    let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;

    beforeEach(() => {
        jest.clearAllMocks();
        document.head.replaceChildren();
        document.body.replaceChildren();
        // jsdom has no object-URL support, and the save service opts itself
        // out without one — stub it so the browser path is what's tested.
        originalCreateObjectUrl = URL.createObjectURL;
        URL.createObjectURL = jest.fn(() => 'blob:latex-adapter');
        loadLatexViewerDeps.mockResolvedValue({ math: { renderToHtml: jest.fn() }, createDOMPurify: jest.fn() });
        coreMountSpy();
    });

    afterEach(() => {
        if (originalCreateObjectUrl) URL.createObjectURL = originalCreateObjectUrl;
        else delete (URL as unknown as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
    });

    it('loads katex.css into both the shadow root and the document', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        await mountLatexViewer(latexFile(), container);

        // Shadow root: the `.katex*` layout selectors only match inside the
        // tree that holds the math.
        const shadowLinks = katexLinks(container.shadowRoot!);
        expect(shadowLinks).toHaveLength(1);
        expect(shadowLinks[0].href).toContain(KATEX_STYLESHEET_PATH);

        // Document: @font-face is document-scoped and is ignored inside a
        // shadow tree, so without this the glyph metrics break.
        const headLinks = katexLinks(document.head);
        expect(headLinks).toHaveLength(1);
        expect(headLinks[0].href).toContain(KATEX_STYLESHEET_PATH);
    });

    it('resolves the stylesheet through the extension URL so the relative font paths keep working', async () => {
        const container = document.createElement('div');
        await mountLatexViewer(latexFile(), container);
        expect(katexLinks(document.head)[0].href).toBe(
            `chrome-extension://omni-viewer-test/${KATEX_STYLESHEET_PATH}`
        );
    });

    it('does not stack duplicate stylesheets across mounts', async () => {
        const first = document.createElement('div');
        const second = document.createElement('div');
        await mountLatexViewer(latexFile(), first);
        await mountLatexViewer(latexFile(), second);

        expect(katexLinks(document.head)).toHaveLength(1);
        expect(katexLinks(first.shadowRoot!)).toHaveLength(1);
        expect(katexLinks(second.shadowRoot!)).toHaveLength(1);
    });

    it('passes the loaded renderers as a mount option, not a positional argument', async () => {
        const deps = { math: { renderToHtml: jest.fn() }, createDOMPurify: jest.fn() };
        loadLatexViewerDeps.mockResolvedValue(deps);

        await mountLatexViewer(latexFile(), document.createElement('div'));

        const [input, , , options] = mountCoreLatexViewer.mock.calls[0];
        expect(options).toEqual({ deps });
        expect(input).toEqual(expect.objectContaining({ fileName: 'paper.tex' }));
        expect(input.data).toBeInstanceOf(Uint8Array);
    });

    it('mounts with the preview intact when KaTeX or DOMPurify is unavailable', async () => {
        // `loadLatexViewerDeps` returns {} unless *both* loaded — the core
        // then keeps structure and outline and leaves formulas as TeX. The
        // adapter must not treat that as a failure or force source mode.
        loadLatexViewerDeps.mockResolvedValue({});
        const container = document.createElement('div');

        const handle = await mountLatexViewer(latexFile(), container);

        expect(handle).toBeDefined();
        expect(mountCoreLatexViewer.mock.calls[0][3]).toEqual({ deps: {} });
        expect(katexLinks(container.shadowRoot!)).toHaveLength(1);
    });

    it('offers save and navigation, and adds writeback only for a writable handle', async () => {
        await mountLatexViewer(latexFile(), document.createElement('div'));
        const withoutHandle = mountCoreLatexViewer.mock.calls[0][2] as CoreContext;
        expect(withoutHandle.save).toBeDefined();
        expect(withoutHandle.navigation).toBeDefined();
        expect(withoutHandle.writeback).toBeUndefined();

        const write = jest.fn(async () => undefined);
        const close = jest.fn(async () => undefined);
        const fileHandle = {
            requestPermission: jest.fn(async () => 'granted' as PermissionState),
            createWritable: jest.fn(async () => ({ write, close }))
        };
        await mountLatexViewer(latexFile(), document.createElement('div'), fileHandle);
        const withHandle = mountCoreLatexViewer.mock.calls[1][2] as CoreContext;

        const bytes = new TextEncoder().encode('\\documentclass{book}');
        await withHandle.writeback!.write(bytes);
        expect(fileHandle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
        expect(write).toHaveBeenCalledWith(bytes);
        expect(close).toHaveBeenCalled();
    });

    it('refuses to write back when the readwrite permission is denied', async () => {
        const fileHandle = {
            requestPermission: jest.fn(async () => 'denied' as PermissionState),
            createWritable: jest.fn()
        };
        await mountLatexViewer(latexFile(), document.createElement('div'), fileHandle);
        const ctx = mountCoreLatexViewer.mock.calls[0][2] as CoreContext;

        await expect(ctx.writeback!.write(new Uint8Array())).rejects.toThrow('write permission denied');
        expect(fileHandle.createWritable).not.toHaveBeenCalled();
    });

    it('translates through chrome.i18n first and falls back to the core catalog', async () => {
        // The core keys are dotted (`latex.preview`); chrome.i18n names are
        // underscored, and an untranslated key comes back as ''.
        const chromeApi = chrome as unknown as { i18n?: { getMessage(key: string): string } };
        const original = chromeApi.i18n;
        chromeApi.i18n = { getMessage: (key: string) => (key === 'latex_preview' ? 'Vorschau' : '') };

        try {
            await mountLatexViewer(latexFile(), document.createElement('div'));
            const ctx = mountCoreLatexViewer.mock.calls[0][2] as CoreContext;

            expect(ctx.i18n.t('latex.preview')).toBe('Vorschau');
            expect(ctx.i18n.t('latex.partialRender')).toBe('latex.partialRender');
        } finally {
            chromeApi.i18n = original;
        }
    });

    it('registers a disposable provider on the viewer registry entry', async () => {
        const registration = VIEWER_REGISTRATIONS.find((r) => r.viewType === 'omni-viewer.latexViewer');
        expect(registration).toBeDefined();
        expect(registration!.slug).toBe('latex');

        const provider = registration!.createProvider();
        const container = document.createElement('div');
        await provider.render(latexFile(), container);
        expect(mountCoreLatexViewer).toHaveBeenCalledTimes(1);

        const handle = await mountCoreLatexViewer.mock.results[0].value;
        provider.dispose!();
        expect(handle.dispose).toHaveBeenCalled();
    });
});
