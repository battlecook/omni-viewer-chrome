// Detection coverage for the viewer that actually ships.
//
// `src/app.js` is the legacy SPA loaded by viewer.html, and its own
// `detectType` — not `src/utils/fileUtils.ts` — is what routes a real file to
// the Keras viewer. The fileUtils suite exercises a second, currently
// unreferenced copy of the same logic, so these cases drive app.js end to end
// (launchQueue -> openFile -> detectType) and assert on the format label it
// renders into #fileMeta.
import { TextDecoder as NodeTextDecoder } from 'util';

const HDF5_SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

function bytesOf(text: string): Uint8Array {
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

/**
 * A ZIP built from stored (uncompressed) members, as Keras writes them.
 * Members carry real payloads and, where asked, an extra field, so a header
 * walk only reaches the second entry if it advances past both.
 */
function zipBytes(
    entries: Array<{ name: string; data?: Uint8Array; extra?: Uint8Array }>
): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const { name, data = new Uint8Array(0), extra = new Uint8Array(0) } of entries) {
        const nameBytes = bytesOf(name);
        const header = new Uint8Array(30 + nameBytes.length + extra.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);  // local file header signature
        view.setUint16(4, 20, true);           // version needed
        view.setUint16(6, 0, true);            // flags — sizes are in this header
        view.setUint16(8, 0, true);            // method: stored
        view.setUint32(18, data.length, true); // compressed size
        view.setUint32(22, data.length, true); // uncompressed size
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, extra.length, true);
        header.set(nameBytes, 30);
        header.set(extra, 30 + nameBytes.length);
        parts.push(header, data);
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/**
 * The three members Keras 3 writes, with payloads and an extra field on the
 * first entry, so the walk in `zipEntryNames` has to consume both the data and
 * the extra field to reach `model.weights.h5`.
 */
function kerasArchiveBytes(prefix = ''): Uint8Array {
    return zipBytes([
        {
            name: `${prefix}metadata.json`,
            data: bytesOf('{"keras_version":"3.5.0","date_saved":"2026-08-14@20:00:00"}'),
            extra: Uint8Array.from([0x55, 0x54, 0x05, 0x00, 0x01, 0, 0, 0, 0])
        },
        {
            name: `${prefix}config.json`,
            data: bytesOf(JSON.stringify({
                module: 'keras',
                class_name: 'Sequential',
                config: { name: 'sequential', layers: [{ class_name: 'Dense' }] }
            }))
        },
        {
            name: `${prefix}model.weights.h5`,
            data: Uint8Array.from(HDF5_SIGNATURE)
        }
    ]);
}

function hdf5Bytes(): Uint8Array {
    const bytes = new Uint8Array(64);
    bytes.set(HDF5_SIGNATURE);
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

describe('legacy SPA Keras detection', () => {
    it('routes a .keras archive to the Keras viewer', async () => {
        expect(await openInSpa(fakeFile('mnist.keras', kerasArchiveBytes()))).toContain('Keras');
    });

    it('routes a Keras 2 model named .keras to the Keras viewer', async () => {
        expect(await openInSpa(fakeFile('legacy.keras', hdf5Bytes()))).toContain('Keras');
    });

    it('leaves a plain .h5 file with the HDF5 viewer', async () => {
        const meta = await openInSpa(fakeFile('dataset.h5', hdf5Bytes()));
        expect(meta).toContain('HDF5');
        expect(meta).not.toContain('Keras');
    });

    it('recognizes a renamed Keras archive by its root members', async () => {
        // The name of the last member is only reachable by advancing over the
        // two before it, payloads and extra field included.
        expect(await openInSpa(fakeFile('model.bin', kerasArchiveBytes()))).toContain('Keras');
    });

    it('leaves an archive holding only one of the two members alone', async () => {
        const bytes = zipBytes([
            { name: 'model.weights.h5', data: Uint8Array.from(HDF5_SIGNATURE) },
            { name: 'notes.txt', data: bytesOf('kept the weights, dropped the model') }
        ]);
        const meta = await openInSpa(fakeFile('training-run.zip', bytes));
        expect(meta).toContain('Archive');
        expect(meta).not.toContain('Keras');
    });

    it('does not claim an archive whose Keras members sit under a folder', async () => {
        // An unpacked model re-zipped: the core resolves members by their root
        // name, so this is an archive to browse, not a model to open.
        const meta = await openInSpa(fakeFile('export.zip', kerasArchiveBytes('my_model/')));
        expect(meta).toContain('Archive');
        expect(meta).not.toContain('Keras');
    });

    it('falls back to the .keras extension when the archive header is gone', async () => {
        expect(await openInSpa(fakeFile('truncated.keras', new Uint8Array(16)))).toContain('Keras');
    });
});
