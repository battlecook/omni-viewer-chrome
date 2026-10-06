// Detection coverage for the viewer that actually ships: `src/app.js`'s own
// `detectType` has to claim a notebook by its contents, because the format is
// JSON and carries no magic bytes. The head read stops at 64 KB and top-level
// key order is writer-dependent — nbconvert/JupyterLab put `cells` first and
// `nbformat` last, Colab the other way round — so each of the two signals has
// to identify a renamed export on its own. These cases pin both directions,
// and `FileUtils.detectViewerType` has to agree with every one of them
// (see fileUtils.test.ts).
import { TextDecoder as NodeTextDecoder } from 'util';

const NOTEBOOK = JSON.stringify({
    cells: [
        { cell_type: 'markdown', source: ['# Analysis\n'] },
        {
            cell_type: 'code',
            execution_count: 1,
            source: ['print(1)\n'],
            outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }]
        }
    ],
    metadata: { language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5
}, null, 2);

/** Cells first, so `nbformat` falls outside the 64 KB head (nbconvert order). */
const LONG_NOTEBOOK = JSON.stringify({
    cells: [
        { cell_type: 'code', execution_count: 1, source: ['print(1)\n'], outputs: [] },
        { cell_type: 'markdown', source: ['x'.repeat(70 * 1024)] }
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
});

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
            // app.js reads a 64 KB head; hand back the same prefix the browser
            // would, so an oversized fixture is truncated the same way.
            arrayBuffer: () => Promise.resolve(head.slice(0, 65536).buffer)
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

describe('legacy SPA notebook detection', () => {
    it('routes an .ipynb notebook to the notebook viewer', async () => {
        expect(await openInSpa([fakeFile('analysis.ipynb', bytesOf(NOTEBOOK))]))
            .toContain('Jupyter Notebook');
    });

    it('claims a notebook renamed to .json by its contents', async () => {
        expect(await openInSpa([fakeFile('export.json', bytesOf(NOTEBOOK))]))
            .toContain('Jupyter Notebook');
    });

    it('routes an extensionless notebook the same way', async () => {
        expect(await openInSpa([fakeFile('export', bytesOf(NOTEBOOK))]))
            .toContain('Jupyter Notebook');
    });

    it('still claims a notebook whose nbformat falls past the head window', async () => {
        const file = fakeFile('big.json', bytesOf(LONG_NOTEBOOK));
        expect(await openInSpa([file])).toContain('Jupyter Notebook');
    });

    it('claims a notebook whose nbformat precedes a long metadata block', async () => {
        // Colab and omni-viewer-core's own sample notebook write `nbformat`
        // first and `cells` last, so a big `metadata` block can push `cells`
        // past the 64 KB head — `nbformat` alone has to be enough. This is
        // also where the two detection mirrors would drift apart.
        const colab = '{"nbformat":4,"nbformat_minor":0,"metadata":{"widgets":{"state":"'
            + 'w'.repeat(70 * 1024)
            + '"}},"cells":[{"cell_type":"code","source":["print(1)"]}]}';
        expect(await openInSpa([fakeFile('colab-export.json', bytesOf(colab))]))
            .toContain('Jupyter Notebook');
    });

    it('claims a notebook that opens with a UTF-8 BOM', async () => {
        // The head is decoded as UTF-8, not read byte-for-byte as latin1: a
        // BOM left as mojibake would survive `trimStart()` and defeat the
        // leading `{` every JSON-shaped sniff requires.
        const bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
        const body = bytesOf(NOTEBOOK);
        const withBom = new Uint8Array(bom.length + body.length);
        withBom.set(bom);
        withBom.set(body, bom.length);
        expect(await openInSpa([fakeFile('bom.json', withBom)]))
            .toContain('Jupyter Notebook');
    });

    it('leaves a complete JSON document with cells but no nbformat on the JSON viewer', async () => {
        // Nothing is truncated, so `nbformat` — which every real notebook
        // carries — is genuinely absent, and the core would refuse this.
        const meta = await openInSpa([
            fakeFile(
                'export.json',
                bytesOf('{"cells":[{"cell_type":"code","source":["print(1)"]}],"metadata":{}}')
            )
        ]);
        expect(meta).toContain('JSON');
        expect(meta).not.toContain('Jupyter');
    });

    it('does not claim a JSON document that merely wraps a notebook', async () => {
        // A Jupyter Contents API response carries the notebook under
        // `content`; the core reads `nbformat`/`cells` off the parsed root and
        // would refuse it with a version error, so this has to stay JSON.
        const wrapped = `{"name":"Untitled.ipynb","type":"notebook","content":${NOTEBOOK}}`;
        const meta = await openInSpa([fakeFile('response.json', bytesOf(wrapped))]);
        expect(meta).toContain('JSON');
        expect(meta).not.toContain('Jupyter');
    });

    it('leaves a line-delimited corpus of notebooks on the JSONL viewer', async () => {
        // FileUtils resolves the JSONL extension ahead of the content sniffs;
        // the SPA has to agree, or the two mirrors disagree on this file.
        const record = '{"cells":[{"cell_type":"code","source":["print(1)"]}],"nbformat":4}';
        const meta = await openInSpa([
            fakeFile('notebooks.jsonl', bytesOf(`${record}\n${record}\n`))
        ]);
        expect(meta).toContain('JSONL');
        expect(meta).not.toContain('Jupyter');
    });

    it('leaves an ordinary JSON document with a cells field on the JSON viewer', async () => {
        const meta = await openInSpa([
            fakeFile('sheet.json', bytesOf('{"cells":[{"id":1,"value":"a1"}]}'))
        ]);
        expect(meta).toContain('JSON');
        expect(meta).not.toContain('Jupyter');
    });
});
