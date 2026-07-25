jest.mock('omni-viewer-core/viewers/ppt', () => ({ mountPptViewer: jest.fn() }));
jest.mock('omni-viewer-core/viewers/csv', () => ({ mountCsvViewer: jest.fn() }));
jest.mock('omni-viewer-core/viewers/yaml', () => ({ mountYamlViewer: jest.fn() }));
jest.mock('omni-viewer-core/parsers/yaml/self-loading', () => ({
    loadYamlParserDeps: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('omni-viewer-core/viewers/toml', () => ({ mountTomlViewer: jest.fn() }));
jest.mock('omni-viewer-core/viewers/json', () => ({ mountJsonViewer: jest.fn() }));
jest.mock('omni-viewer-core/viewers/excel', () => ({ mountExcelViewer: jest.fn() }));
jest.mock('omni-viewer-core/viewers/archive', () => ({ mountArchiveViewer: jest.fn() }));
jest.mock('omni-viewer-core/viewers/markdown', () => ({ mountMarkdownViewer: jest.fn() }));
jest.mock('omni-viewer-core/viewers/markdown/self-loading', () => ({
    loadMarkdownViewerDeps: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../templates/archive/js/archiveLoader', () => ({ openArchive: jest.fn() }));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveCatalogMessage: (key: string) => key
}));

import { createChromeFileSaveService } from '../utils/chromeFileSaveService';
import { installPptKeyboardNavigation } from '../templates/ppt/js/pptViewer';
import { installCsvKeyboardShortcuts } from '../templates/csv/js/csvViewer';
import { mountYamlViewer as mountChromeYamlViewer } from '../templates/yaml/js/yamlViewer';
import { mountTomlViewer as mountChromeTomlViewer } from '../templates/toml/js/tomlViewer';
import { mountJsonViewer as mountChromeJsonViewer } from '../templates/json/js/jsonViewer';
import { mountExcelViewer as mountChromeExcelViewer } from '../templates/excel/js/excelViewer';
import { mountArchiveViewer as mountChromeArchiveViewer } from '../templates/archive/js/archiveViewer';
import { mountMarkdownViewer as mountChromeMarkdownViewer } from '../templates/markdown/js/markdownViewer';

describe('Chrome file-save service', () => {
    const chromeWithDownloads = chrome as unknown as {
        downloads?: { download: jest.Mock<Promise<number>, [chrome.downloads.DownloadOptions]> };
    };
    let originalDownloads: typeof chromeWithDownloads.downloads;
    let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;
    let originalRevokeObjectUrl: typeof URL.revokeObjectURL | undefined;

    beforeEach(() => {
        jest.useFakeTimers();
        originalDownloads = chromeWithDownloads.downloads;
        originalCreateObjectUrl = URL.createObjectURL;
        originalRevokeObjectUrl = URL.revokeObjectURL;
        URL.createObjectURL = jest.fn(() => 'blob:adapter-save');
        URL.revokeObjectURL = jest.fn();
    });

    afterEach(() => {
        chromeWithDownloads.downloads = originalDownloads;
        if (originalCreateObjectUrl) URL.createObjectURL = originalCreateObjectUrl;
        else delete (URL as unknown as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
        if (originalRevokeObjectUrl) URL.revokeObjectURL = originalRevokeObjectUrl;
        else delete (URL as unknown as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
        jest.useRealTimers();
    });

    it('uses an anchor download even when chrome.downloads is available', async () => {
        const download = jest.fn<Promise<number>, [chrome.downloads.DownloadOptions]>()
            .mockResolvedValue(7);
        chromeWithDownloads.downloads = { download };
        const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation();

        const service = createChromeFileSaveService();
        expect(service).toBeDefined();
        await service!.saveFile('edited.yaml', new Uint8Array([1, 2]), 'text/yaml');

        expect(download).not.toHaveBeenCalled();
        expect(click).toHaveBeenCalledTimes(1);
        expect(document.querySelector('a[download="edited.yaml"]')).toBeNull();
        jest.runOnlyPendingTimers();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:adapter-save');
        click.mockRestore();
    });

    it('uses an anchor download when the downloads API is unavailable', async () => {
        chromeWithDownloads.downloads = undefined;
        const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation();

        await createChromeFileSaveService()!.saveFile(
            'workbook.xlsx',
            new Uint8Array([3]),
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );

        expect(click).toHaveBeenCalledTimes(1);
        expect(document.querySelector('a[download="workbook.xlsx"]')).toBeNull();
        click.mockRestore();
    });

    it.each([
        ['yaml', mountChromeYamlViewer, 'omni-viewer-core/viewers/yaml'],
        ['toml', mountChromeTomlViewer, 'omni-viewer-core/viewers/toml'],
        ['json', mountChromeJsonViewer, 'omni-viewer-core/viewers/json'],
        ['excel', mountChromeExcelViewer, 'omni-viewer-core/viewers/excel']
    ] as const)('injects the save service into the %s core viewer', async (_name, mount, moduleName) => {
        const coreMount = (jest.requireMock(moduleName) as Record<string, jest.Mock>)[
            `mount${_name[0]!.toUpperCase()}${_name.slice(1)}Viewer`
        ]!;
        coreMount.mockClear();
        const file = {
            name: `sample.${_name}`,
            lastModified: 1,
            arrayBuffer: async () => new ArrayBuffer(0)
        } as File;

        await mount(file, document.createElement('div'));

        expect(coreMount).toHaveBeenCalledTimes(1);
        expect(coreMount.mock.calls[0]![2].save).toEqual({
            saveFile: expect.any(Function)
        });
    });
});

describe('Archive Chrome adapter', () => {
    it('shows an encrypted-entry warning around the core archive viewer', async () => {
        const openArchive = (jest.requireMock('../templates/archive/js/archiveLoader') as {
            openArchive: jest.Mock;
        }).openArchive;
        openArchive.mockResolvedValue({
            entries: [{ path: 'secret.txt', size: 12, isDirectory: false }],
            extract: jest.fn(),
            hasEncryptedData: jest.fn().mockResolvedValue(true),
            close: jest.fn().mockResolvedValue(undefined)
        });

        const coreMount = (jest.requireMock('omni-viewer-core/viewers/archive') as {
            mountArchiveViewer: jest.Mock;
        }).mountArchiveViewer;
        coreMount.mockImplementation(async (
            input: { data: Uint8Array },
            container: HTMLElement,
            _context: unknown,
            deps: { openArchive(data: Uint8Array): Promise<unknown> }
        ) => {
            await deps.openArchive(input.data);
            const root = container.attachShadow({ mode: 'open' });
            const viewer = document.createElement('section');
            viewer.className = 'omni-viewer--archive';
            const hero = document.createElement('header');
            hero.className = 'omni-archive__hero';
            viewer.append(hero);
            root.append(viewer);
            return { dispose: jest.fn() };
        });

        const container = document.createElement('div');
        const file = {
            name: 'encrypted.zip',
            lastModified: 1,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
        } as File;
        await mountChromeArchiveViewer(file, container);

        const warning = container.shadowRoot?.querySelector(
            '.omni-archive__encryption-warning'
        );
        expect(warning?.textContent).toContain('encrypted entries');
        expect(warning?.getAttribute('role')).toBe('status');
    });
});

describe('Markdown Chrome adapter writeback', () => {
    const coreMount = (jest.requireMock('omni-viewer-core/viewers/markdown') as {
        mountMarkdownViewer: jest.Mock;
    }).mountMarkdownViewer;

    const markdownFile = () => ({
        name: 'notes.md',
        lastModified: 1,
        arrayBuffer: async () => new Uint8Array([35, 32, 72, 105]).buffer
    }) as File;

    type Ctx = {
        writeback?: { write(data: Uint8Array): Promise<void> };
        save?: unknown;
    };

    const lastContext = (): Ctx => coreMount.mock.calls[0]![2] as Ctx;

    let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;

    beforeEach(() => {
        coreMount.mockClear();
        coreMount.mockResolvedValue({ dispose: jest.fn() });
        // The download-based save service only materializes when object URLs are
        // available, so stub it to observe the input/drop fallback path.
        originalCreateObjectUrl = URL.createObjectURL;
        URL.createObjectURL = jest.fn(() => 'blob:markdown-save');
        // The adapter also injects the KaTeX stylesheet into the outer document
        // after mounting; that path is unrelated to writeback. Its id guard
        // short-circuits when the link already exists, so pre-seed it.
        if (!document.getElementById('omni-katex-css')) {
            const link = document.createElement('link');
            link.id = 'omni-katex-css';
            document.head.appendChild(link);
        }
    });

    afterEach(() => {
        if (originalCreateObjectUrl) URL.createObjectURL = originalCreateObjectUrl;
        else delete (URL as unknown as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
    });

    it('injects a writeback that overwrites the original handle on the launchQueue path', async () => {
        const writable = {
            write: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined)
        };
        const handle = {
            requestPermission: jest.fn().mockResolvedValue('granted'),
            createWritable: jest.fn().mockResolvedValue(writable)
        };

        await mountChromeMarkdownViewer(markdownFile(), document.createElement('div'), handle);

        const ctx = lastContext();
        expect(ctx.writeback).toBeDefined();

        const bytes = new Uint8Array([1, 2, 3]);
        await ctx.writeback!.write(bytes);

        expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
        expect(handle.createWritable).toHaveBeenCalledTimes(1);
        expect(writable.write).toHaveBeenCalledWith(bytes);
        expect(writable.close).toHaveBeenCalledTimes(1);
    });

    it('rejects the write when readwrite permission is denied', async () => {
        const writable = {
            write: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined)
        };
        const handle = {
            requestPermission: jest.fn().mockResolvedValue('denied'),
            createWritable: jest.fn().mockResolvedValue(writable)
        };

        await mountChromeMarkdownViewer(markdownFile(), document.createElement('div'), handle);

        await expect(lastContext().writeback!.write(new Uint8Array([9])))
            .rejects.toThrow('write permission denied');
        expect(handle.createWritable).not.toHaveBeenCalled();
        expect(writable.write).not.toHaveBeenCalled();
    });

    it('omits writeback and keeps the save fallback on the input/drop path (no handle)', async () => {
        await mountChromeMarkdownViewer(markdownFile(), document.createElement('div'));

        const ctx = lastContext();
        expect(ctx.writeback).toBeUndefined();
        expect(ctx.save).toEqual({ saveFile: expect.any(Function) });
    });
});

describe('PPT Chrome keyboard navigation', () => {
    it('maps Arrow/Page/Space keys to the public core controller and detaches', () => {
        const container = document.createElement('div');
        const root = container.attachShadow({ mode: 'open' });
        const first = document.createElement('article');
        first.setAttribute('aria-label', 'Slide 1');
        const second = document.createElement('article');
        second.setAttribute('aria-label', 'Slide 2');
        const scrollIntoView = jest.fn();
        second.scrollIntoView = scrollIntoView;
        root.append(first, second);

        let currentSlide = 1;
        const controller = {
            get state() {
                return { currentSlide, slideCount: 2, zoom: 1, mode: 'continuous' as const };
            },
            dispatch(action: { type: string }) {
                if (action.type === 'next') currentSlide = Math.min(2, currentSlide + 1);
                if (action.type === 'previous') currentSlide = Math.max(1, currentSlide - 1);
            },
            subscribe: () => () => undefined
        };
        const handle = {
            controller,
            mode: 'slides' as const,
            dispose: jest.fn()
        } as Parameters<typeof installPptKeyboardNavigation>[1];
        const detach = installPptKeyboardNavigation(container, handle);

        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'PageDown', bubbles: true, cancelable: true
        }));
        expect(currentSlide).toBe(2);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });

        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowLeft', bubbles: true, cancelable: true
        }));
        expect(currentSlide).toBe(1);

        detach();
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: ' ', bubbles: true, cancelable: true
        }));
        expect(currentSlide).toBe(1);
    });

    it('does not hijack form-field keys', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        const dispatch = jest.fn();
        const handle = {
            controller: {
                state: { currentSlide: 1, slideCount: 2, zoom: 1, mode: 'single' },
                dispatch,
                subscribe: () => () => undefined
            },
            mode: 'slides',
            dispose: jest.fn()
        } as Parameters<typeof installPptKeyboardNavigation>[1];
        const detach = installPptKeyboardNavigation(document.createElement('div'), handle);

        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight', bubbles: true, cancelable: true
        }));
        expect(dispatch).not.toHaveBeenCalled();
        detach();
        input.remove();
    });
});

describe('CSV Chrome keyboard shortcuts', () => {
    it('focuses search and invokes the existing filtered TSV copy button', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = container.attachShadow({ mode: 'open' });
        const frame = document.createElement('section');
        frame.className = 'omni-csv';
        const toolbar = document.createElement('div');
        toolbar.className = 'omni-csv__toolbar';
        const search = document.createElement('input');
        search.className = 'omni-csv__search';
        const copy = document.createElement('button');
        copy.textContent = 'Copy TSV';
        const trigger = document.createElement('button');
        const copied = jest.fn();
        copy.addEventListener('click', copied);
        toolbar.append(search, copy, trigger);
        frame.append(toolbar);
        root.append(frame);
        const detach = installCsvKeyboardShortcuts(container, 'Copy TSV');

        trigger.focus();
        trigger.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'f', ctrlKey: true, bubbles: true, composed: true, cancelable: true
        }));
        expect(root.activeElement).toBe(search);

        trigger.focus();
        trigger.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'c', ctrlKey: true, bubbles: true, composed: true, cancelable: true
        }));
        expect(copied).toHaveBeenCalledTimes(1);

        detach();
        trigger.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'c', ctrlKey: true, bubbles: true, composed: true, cancelable: true
        }));
        expect(copied).toHaveBeenCalledTimes(1);
        container.remove();
    });
});
