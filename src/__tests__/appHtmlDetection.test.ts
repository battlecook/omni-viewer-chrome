import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
import { FileUtils, shortNameForViewType } from '../utils/fileUtils';
import JSZip from 'jszip';

function fakeFile(name: string, head: Uint8Array, size = head.length): File {
    return {
        name,
        size,
        type: 'application/octet-stream',
        lastModified: 1,
        slice: jest.fn(() => ({
            arrayBuffer: () => Promise.resolve(head.buffer)
        })),
        arrayBuffer: () => Promise.resolve(head.buffer),
        text: () => Promise.resolve('')
    } as unknown as File;
}

async function openInSpa(files: File[]): Promise<string> {
    document.body.innerHTML = `
        <button id="shareCurrentFile"></button>
        <button id="openSharedLink"></button>
        <select id="languageSelect"></select>
        <input id="fileInput" type="file">
        <div id="dropZone"></div>
        <div id="viewer"></div>
        <div id="status"></div>
        <div id="fileMeta"></div>
        <div id="shareToast"></div>
        <a id="shareToastLink"></a>
    `;
    Object.defineProperty(globalThis, 'TextDecoder', {
        configurable: true,
        value: NodeTextDecoder
    });

    let launchConsumer!: (
        params: { files: Array<{ getFile(): Promise<File> }> }
    ) => Promise<void>;
    Object.defineProperty(window, 'launchQueue', {
        configurable: true,
        value: {
            setConsumer: jest.fn((consumer) => {
                launchConsumer = consumer;
            })
        }
    });
    (chrome.storage.local.get as jest.Mock).mockResolvedValue({});

    jest.isolateModules(() => {
        require('../app.js');
    });
    await launchConsumer({
        files: files.map((file) => ({ getFile: async () => file }))
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return document.querySelector('#fileMeta')?.textContent ?? '';
}

describe('HTML routing in the SPA and FileUtils', () => {
    it.each([
        ['index.html', '<p>HTML fragment</p>'],
        ['index.HTM', '<p>HTML fragment</p>'],
        ['vector.html', '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'],
        ['blank.html', ''],
        ['diagram.html', '@startuml\nAlice -> Bob\n@enduml\n<p>Explanation</p>'],
        ['capture.htm', '{"log":{"entries":[]}}'],
        ['notebook.HTM', '{"nbformat":4,"cells":[]}'],
        ['model.html', '<net version="11"><layers/></net>'],
        ['page', '<!DOCTYPE html><html><body><p>hello</body></html>'],
        ['download.bin', '<HTML lang="ko"><body>hello</body></HTML>'],
        ['page', '\ufeff  <!-- license -->\n<!-- generated -->\n<!DoCtYpE HTML><html></html>']
    ])('routes %s to the core HTML viewer', async (name, source) => {
        const file = fakeFile(name, new NodeTextEncoder().encode(source));
        expect(await openInSpa([file])).toContain('HTML');
        expect((await FileUtils.detectViewerType(file)).viewType).toBe('omni-viewer.htmlViewer');
    });

    it.each([
        ['notes.md', '<!DOCTYPE html><html><body>example</body></html>'],
        ['document.xml', '<html xmlns="http://www.w3.org/1999/xhtml"/>'],
        ['page', '<htmlish><body/></htmlish>'],
        ['fragment', '<p>fragment</p>']
    ])('keeps %s out of HTML content detection', async (name, source) => {
        const file = fakeFile(name, new NodeTextEncoder().encode(source));
        expect(await openInSpa([file])).not.toContain('HTML');
        expect((await FileUtils.detectViewerType(file)).viewType).not.toBe('omni-viewer.htmlViewer');
    });

    it('keeps BOM-encoded .html bytes on the HTML route', async () => {
        const file = fakeFile('page.html', new Uint8Array([0xff, 0xfe, 0x3c, 0, 0x70, 0, 0x3e, 0]));
        expect(await openInSpa([file])).toContain('HTML');
        expect((await FileUtils.detectViewerType(file)).viewType).toBe('omni-viewer.htmlViewer');
    });

    it('maps the HTML view type to its route slug', () => {
        expect(shortNameForViewType('omni-viewer.htmlViewer')).toBe('html');
    });

    it.each([
        ['report.html', new NodeTextEncoder().encode('%PDF-1.7\n'), 'pdf', 'PDF'],
        ['photo.htm', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image', 'Image']
    ])('prefers the binary signature over the HTML extension for %s', async (name, bytes, slug, label) => {
        const file = fakeFile(name, bytes);
        expect(await openInSpa([file])).toContain(label);
        const detected = await FileUtils.detectViewerType(file);
        expect(detected.viewType).toBe(`omni-viewer.${slug}Viewer`);
        expect(detected.matchedBySignature).toBe(true);
    });

    it('preserves ZIP signature detection for a mislabeled HTML file', async () => {
        const zip = new JSZip();
        zip.file('readme.txt', 'A ZIP archive saved with an HTML extension.');
        const file = fakeFile('archive.html', await zip.generateAsync({ type: 'uint8array' }));
        expect(await openInSpa([file])).toContain('Archive');
        const detected = await FileUtils.detectViewerType(file);
        expect(detected.viewType).toBe('omni-viewer.archiveViewer');
        expect(detected.matchedBySignature).toBe(true);
    });
});
