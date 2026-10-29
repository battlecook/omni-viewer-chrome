jest.mock('omni-viewer-core/viewers/font', () => ({ mountFontViewer: jest.fn() }));
jest.mock('omni-viewer-core/viewers/arrow/self-loading', () => ({ mountSelfLoadingArrowViewer: jest.fn() }));
jest.mock('omni-viewer-core/viewers/geojson', () => ({ mountGeoJsonViewer: jest.fn() }));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn((locale: string, key: string) => `${locale}:${key}`)
}));
jest.mock('../utils/chromeFileSaveService', () => ({
    createChromeFileSaveService: () => ({ saveFile: jest.fn() })
}));

import { mountFontViewer } from '../templates/font/js/fontViewer';
import { mountArrowViewer } from '../templates/arrow/js/arrowViewer';
import { mountGeoJsonViewer } from '../templates/geojson/js/geojsonViewer';
import { getRegistrationBySlug, type ViewerSlug } from '../viewerRegistry';

const cases = [
    ['font', mountFontViewer, jest.requireMock('omni-viewer-core/viewers/font').mountFontViewer],
    ['arrow', mountArrowViewer, jest.requireMock('omni-viewer-core/viewers/arrow/self-loading').mountSelfLoadingArrowViewer],
    ['geojson', mountGeoJsonViewer, jest.requireMock('omni-viewer-core/viewers/geojson').mountGeoJsonViewer]
] as const;

describe.each(cases)('%s Chrome core adapter', (slug, mount, coreMount: jest.Mock) => {
    beforeEach(() => {
        jest.clearAllMocks();
        coreMount.mockReset().mockResolvedValue({ dispose: jest.fn() });
        document.documentElement.lang = 'ko-KR';
        Object.assign(chrome, { i18n: { getMessage: jest.fn(() => ''), getUILanguage: () => 'en-US' } });
    });

    it('passes raw file bytes, locale, services, and cancellation to the core', async () => {
        const file = new File([new Uint8Array([0, 1, 2, 3])], `sample.${slug}`, { lastModified: 1234 });
        const host = document.createElement('div');
        const controller = new AbortController();
        await mount(file, host, undefined, controller.signal);
        const [input, container, context, options] = coreMount.mock.calls[0];
        expect(input).toEqual({ fileName: file.name, data: new Uint8Array([0, 1, 2, 3]), lastModified: 1234 });
        expect(container).toBe(host);
        expect(options.signal).toBe(controller.signal);
        expect(context.i18n.t(`${slug}.title`)).toBe(`ko-KR:${slug}.title`);
        expect(context.save.saveFile).toEqual(expect.any(Function));
        expect(await context.assets.resolveAssetUrl('test')).toContain('chrome-extension://');
    });

    it('disposes and aborts a pending render after the provider is closed', async () => {
        let resolve!: (handle: { dispose(): void }) => void;
        const dispose = jest.fn();
        coreMount.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
        const provider = getRegistrationBySlug(slug as ViewerSlug)!.createProvider();
        const container = document.createElement('div');
        const rendering = provider.render(new File(['sample'], `sample.${slug}`), container);
        await Promise.resolve();
        await Promise.resolve();
        provider.dispose?.();
        resolve({ dispose });
        await rendering;
        expect(coreMount.mock.calls[0][3].signal.aborted).toBe(true);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(container.childNodes).toHaveLength(0);
    });

    it('isolates a newer render from a stale mount and its cleanup', async () => {
        let resolve!: (handle: { dispose(): void }) => void;
        let first!: HTMLElement;
        coreMount.mockImplementationOnce((input, container: HTMLElement) => {
            first = container;
            return new Promise((done) => { resolve = done; });
        }).mockImplementationOnce((input, container: HTMLElement) => {
            container.textContent = input.fileName;
            return Promise.resolve({ dispose: () => container.replaceChildren() });
        });
        const provider = getRegistrationBySlug(slug as ViewerSlug)!.createProvider();
        const container = document.createElement('div');
        const pending = provider.render(new File(['a'], 'old'), container);
        await Promise.resolve();
        await Promise.resolve();
        await provider.render(new File(['b'], 'new'), container);
        resolve({ dispose: () => first.replaceChildren() });
        await pending;
        expect(container.textContent).toBe('new');
        provider.dispose?.();
        expect(container.childNodes).toHaveLength(0);
    });

    it('propagates current mount failures and clears its host', async () => {
        coreMount.mockRejectedValueOnce(new Error('invalid file'));
        const container = document.createElement('div');
        const provider = getRegistrationBySlug(slug as ViewerSlug)!.createProvider();
        await expect(provider.render(new File(['bad'], 'bad'), container)).rejects.toThrow('invalid file');
        expect(container.childNodes).toHaveLength(0);
    });
});
