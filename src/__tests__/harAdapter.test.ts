jest.mock('omni-viewer-core/viewers/har', () => ({
    mountHarViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.count ?? ''}`
    )
}));

import { mountHarViewer } from '../templates/har/js/harViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/har') as {
    mountHarViewer: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

const ARCHIVE = '{"log":{"version":"1.2","creator":{"name":"WebInspector"},"entries":[]}}';

describe('HAR Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountHarViewer.mockResolvedValue({ dispose });
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
    });

    it('passes the archive bytes to omni-viewer-core', async () => {
        // jest-environment-jsdom@29 ships no TextEncoder global, so the
        // fixture bytes are built by hand (the archive is pure ASCII).
        const bytes = Uint8Array.from(ARCHIVE, (char) => char.charCodeAt(0));
        const file = new File([bytes], 'network.har', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountHarViewer(file, container);

        expect(core.mountHarViewer).toHaveBeenCalledWith(
            {
                fileName: 'network.har',
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

    it('bounds the container so the core panes scroll internally', async () => {
        // The core layout is `height: 100%` over `overflow: auto` panes, so an
        // unbounded container resolves to `auto` and nothing scrolls: measured
        // in Chrome, a 600-entry archive stretched the panel to ~25,000 px and
        // left the detail pane far above the row just clicked.
        const container = document.createElement('div');
        await mountHarViewer(new File([ARCHIVE], 'network.har'), container);

        // jsdom's CSSOM silently drops `min()`, so only the floor is
        // assertable here; the bound itself was measured in Chrome (600-entry
        // archive: panel 24,925 px -> 662 px, list scrolls internally).
        expect(container.style.minHeight).toBe('560px');
    });

    it('offers a clipboard service so the copy actions render', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true
        });

        await mountHarViewer(new File([ARCHIVE], 'network.har'), document.createElement('div'));
        const viewerContext = core.mountHarViewer.mock.calls[0][2];
        await viewerContext.clipboard.writeText('GET /api');

        expect(writeText).toHaveBeenCalledWith('GET /api');
    });

    it('prefers the app-selected document locale for core catalog fallbacks', async () => {
        await mountHarViewer(new File([ARCHIVE], 'network.har'), document.createElement('div'));
        const viewerContext = core.mountHarViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('har.requestCount', { count: 42 })).toBe(
            'ko-KR:har.requestCount:42'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'har.requestCount',
            { count: 42 }
        );
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountHarViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.harViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            {
                name: 'slow.har',
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

        const options = core.mountHarViewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures', async () => {
        core.mountHarViewer.mockRejectedValueOnce(new Error('not a HAR archive'));

        await expect(
            mountHarViewer(
                new File(['<html></html>'], 'broken.har'),
                document.createElement('div')
            )
        ).rejects.toThrow('not a HAR archive');
    });
});
