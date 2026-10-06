// Detection coverage for the viewer that actually ships: `src/app.js`'s own
// `detectType` has to claim a HAR archive by its `log`/`entries` pair, because
// the format is JSON and carries no magic bytes. A renamed capture (`.json`,
// extensionless) is the common case — browsers hand them out as `.har`, but
// bug reports arrive with whatever name the reporter chose.
import { TextDecoder as NodeTextDecoder } from 'util';

const HAR = JSON.stringify({
    log: {
        version: '1.2',
        creator: { name: 'WebInspector', version: '537.36' },
        pages: [{ id: 'page_1', title: 'https://example.test/checkout' }],
        entries: [
            {
                startedDateTime: '2026-10-05T09:00:00.000Z',
                time: 812.5,
                request: { method: 'POST', url: 'https://api.example.test/pay' },
                response: { status: 502, statusText: 'Bad Gateway' }
            }
        ]
    }
}, null, 2);

function bytesOf(text: string): Uint8Array {
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function fakeFile(name: string, head: Uint8Array, size = head.length): File {
    return {
        name,
        size,
        type: 'application/json',
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
        <input id="fileInput" type="file" multiple>
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
    await launchConsumer({ files: files.map((file) => ({ getFile: async () => file })) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return document.querySelector('#fileMeta')?.textContent ?? '';
}

describe('legacy SPA HAR detection', () => {
    it('routes a .har capture to the HAR viewer', async () => {
        expect(await openInSpa([fakeFile('checkout.har', bytesOf(HAR))])).toContain('HAR');
    });

    it('claims a capture renamed to .json by its log/entries pair', async () => {
        expect(await openInSpa([fakeFile('checkout.json', bytesOf(HAR))])).toContain('HAR');
    });

    it('routes an extensionless capture the same way', async () => {
        expect(await openInSpa([fakeFile('capture', bytesOf(HAR))])).toContain('HAR');
    });

    it('claims a minified single-line capture', async () => {
        const minified = JSON.stringify(JSON.parse(HAR));
        expect(await openInSpa([fakeFile('capture.json', bytesOf(minified))])).toContain('HAR');
    });

    it('claims a BOM-prefixed capture', async () => {
        // Fiddler and PowerShell-written captures carry a UTF-8 BOM. The head
        // is decoded with TextDecoder, which strips it; the latin1 `ascii()`
        // view would leave three mojibake characters ahead of the `{`.
        const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf(HAR)]);
        expect(await openInSpa([fakeFile('capture.json', withBom)])).toContain('HAR');
    });

    it('does not claim an entries array that belongs to a sibling of log', async () => {
        const meta = await openInSpa([
            fakeFile(
                'report.json',
                bytesOf('{"log":{"level":"warn"},"cache":{"entries":[{"key":"a"}]}}')
            )
        ]);
        expect(meta).toContain('JSON');
        expect(meta).not.toContain('HAR');
    });

    it('does not claim a JSON document that merely wraps a capture', async () => {
        const meta = await openInSpa([
            fakeFile(
                'attachment.json',
                bytesOf(`{"meta":{"ticket":"BUG-1"},"har":${HAR}}`)
            )
        ]);
        expect(meta).toContain('JSON');
        expect(meta).not.toContain('HAR');
    });

    it('leaves a line-delimited corpus of captures on the JSONL viewer', async () => {
        // Each record is HAR-shaped, so the content sniff would claim the file
        // outright; the JSONL extension has to win, as it does in the core's
        // sniff order (jsonl, har, notebook, json) and in FileUtils.
        const minified = JSON.stringify(JSON.parse(HAR));
        const meta = await openInSpa([
            fakeFile('captures.ndjson', bytesOf(`${minified}\n${minified}\n`))
        ]);
        expect(meta).toContain('JSONL');
        expect(meta).not.toContain('HAR');
    });

    it('leaves an ordinary JSON document with a log field on the JSON viewer', async () => {
        const meta = await openInSpa([
            fakeFile('app.json', bytesOf('{"log":{"level":"warn","message":"nope"}}'))
        ]);
        expect(meta).toContain('JSON');
        expect(meta).not.toContain('HAR');
    });
});
