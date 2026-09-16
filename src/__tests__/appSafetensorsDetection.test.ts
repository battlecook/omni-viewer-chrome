// Detection coverage for the viewer that actually ships.
//
// `src/app.js` is the legacy SPA loaded by viewer.html, and its own
// `detectType` / `isSafetensorsHead` pair — not `src/utils/fileUtils.ts` — is
// what routes a real file to the safetensors viewer. The fileUtils suite
// exercises a second, currently unreferenced copy of the same logic, so these
// cases drive app.js end to end (launchQueue -> openFile -> detectType) and
// assert on the format label it renders into #fileMeta.
import { TextDecoder as NodeTextDecoder } from 'util';

const HEADER_JSON = '{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}';

/** 8-byte LE header length, that many bytes of JSON, then the payload. */
function safetensorsBytes(headerLength = HEADER_JSON.length): Uint8Array {
    const bytes = new Uint8Array(8 + HEADER_JSON.length + 4);
    new DataView(bytes.buffer).setUint32(0, headerLength, true);
    bytes.set(Uint8Array.from(HEADER_JSON, (char) => char.charCodeAt(0)), 8);
    return bytes;
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

async function openInSpa(file: File): Promise<string> {
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
    await launchConsumer({ files: [{ getFile: async () => file }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return document.querySelector('#fileMeta')?.textContent ?? '';
}

describe('legacy SPA safetensors detection', () => {
    it('routes a safetensors header to the safetensors viewer despite a misleading name', async () => {
        const meta = await openInSpa(fakeFile('weights.bin', safetensorsBytes()));
        expect(meta).toContain('Safetensors');
    });

    it('rejects a header length that runs past the end of the file', async () => {
        // Bytes 8-9 still read `{"`, so only the length check can save this.
        const meta = await openInSpa(fakeFile('mystery.bin', safetensorsBytes(0xffff)));
        expect(meta).not.toContain('Safetensors');
        expect(meta).toContain('Raw Data');
    });

    it('rejects a non-zero high word in the 64-bit header length', async () => {
        const bytes = safetensorsBytes();
        new DataView(bytes.buffer).setUint32(4, 1, true);
        const meta = await openInSpa(fakeFile('mystery.bin', bytes));
        expect(meta).not.toContain('Safetensors');
    });

    it('falls back to the .safetensors extension when the header is gone', async () => {
        const meta = await openInSpa(fakeFile('truncated.safetensors', new Uint8Array(16)));
        expect(meta).toContain('Safetensors');
    });

    it('leaves an NPY file with the NumPy viewer', async () => {
        const npy = new Uint8Array(16);
        npy.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x01, 0x00]);
        const meta = await openInSpa(fakeFile('array.npy', npy));
        expect(meta).toContain('NumPy');
        expect(meta).not.toContain('Safetensors');
    });
});
