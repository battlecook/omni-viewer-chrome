// Detection coverage for the viewer that actually ships: `src/app.js`'s own
// `detectType` routes an IR by its `<net>` root, and its multi-file intake
// pairs the `.xml` with the `.bin` that arrived alongside it.
import { TextDecoder as NodeTextDecoder } from 'util';

const IR = `<?xml version="1.0"?>
<!-- exported by openvino 2024.3 -->
<net name="tiny_mlp" version="11">
    <layers>
        <layer id="0" name="input" type="Parameter" version="opset1"><data shape="1,4" element_type="f32"/></layer>
    </layers>
    <edges/>
</net>`;

function bytesOf(text: string): Uint8Array {
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

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

describe('legacy SPA OpenVINO IR detection', () => {
    it('routes an IR .xml to the OpenVINO viewer by its <net> root', async () => {
        expect(await openInSpa([fakeFile('tiny_mlp.xml', bytesOf(IR))])).toContain('OpenVINO IR');
    });

    it('routes an extensionless IR the same way', async () => {
        expect(await openInSpa([fakeFile('tiny_mlp', bytesOf(IR))])).toContain('OpenVINO IR');
    });

    it('leaves other XML documents alone', async () => {
        const meta = await openInSpa([
            fakeFile('config.xml', bytesOf('<?xml version="1.0"?><config><layers/></config>'))
        ]);
        expect(meta).not.toContain('OpenVINO');
    });

    it('does not claim a <net> root that carries no IR version', async () => {
        const meta = await openInSpa([
            fakeFile('graph.xml', bytesOf('<net name="social"><layers/></net>'))
        ]);
        expect(meta).not.toContain('OpenVINO');
    });

    it('opens the .xml of a pair whichever order the files arrive in', async () => {
        const meta = await openInSpa([
            fakeFile('tiny_mlp.bin', new Uint8Array(16)),
            fakeFile('tiny_mlp.xml', bytesOf(IR))
        ]);
        expect(meta).toContain('tiny_mlp.xml');
        expect(meta).toContain('OpenVINO IR');
    });

    it('still opens the first file when the batch is not an IR pair', async () => {
        const meta = await openInSpa([
            fakeFile('notes.bin', new Uint8Array(16)),
            fakeFile('other.bin', new Uint8Array(16))
        ]);
        expect(meta).toContain('notes.bin');
    });
});
