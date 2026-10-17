// Detection coverage for the viewer that actually ships.
//
// `src/app.js` is the legacy SPA loaded by viewer.html, and its own
// `detectType` — not `src/utils/fileUtils.ts` — is what routes a real file to
// the Shapefile and ExportedProgram viewers. These cases drive app.js end to
// end (launchQueue -> openFile -> detectType) and assert on the format label it
// renders into #fileMeta.
import { TextDecoder as NodeTextDecoder } from 'util';

function bytesOf(text: string): Uint8Array {
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

/**
 * A `.shp` header: file code 9994 big-endian at offset 0, version 1000
 * little-endian at offset 28, shape type at 32, over the 100 bytes the format
 * reserves. A `.shx` index is byte-identical here, which is the point of the
 * extension guard the SPA applies.
 */
function shapefileBytes(shapeType = 5): Uint8Array {
    const bytes = new Uint8Array(100);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, 9994, false);
    view.setInt32(24, 50, false); // file length in 16-bit words
    view.setInt32(28, 1000, true);
    view.setInt32(32, shapeType, true);
    return bytes;
}

/** A ZIP built from stored (uncompressed) members, with real payloads. */
function zipBytes(entries: Array<{ name: string; data?: Uint8Array }>): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const { name, data = new Uint8Array(0) } of entries) {
        const nameBytes = bytesOf(name);
        const header = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);   // local file header signature
        view.setUint16(4, 20, true);            // version needed
        view.setUint16(6, 0, true);             // flags — sizes are in this header
        view.setUint16(8, 0, true);             // method: stored
        view.setUint32(18, data.length, true);  // compressed size
        view.setUint32(22, data.length, true);  // uncompressed size
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true);            // extra length
        header.set(nameBytes, 30);
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

/** The members torch.export writes into a `.pt2` package. */
function pt2ArchiveBytes(prefix = ''): Uint8Array {
    return zipBytes([
        { name: `${prefix}archive_format`, data: bytesOf('pt2') },
        { name: `${prefix}archive_version`, data: bytesOf('0') },
        {
            name: `${prefix}models/model.json`,
            data: bytesOf('{"graph_module":{"graph":{"nodes":[]}}}')
        }
    ]);
}

/** The pre-`archive_format` layout the core still reads. */
function legacyPt2ArchiveBytes(): Uint8Array {
    return zipBytes([
        {
            name: 'serialized_exported_program.json',
            data: bytesOf('{"graph_module":{"graph":{"nodes":[]}}}')
        }
    ]);
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

describe('legacy SPA Shapefile detection', () => {
    it('routes a .shp to the Shapefile viewer', async () => {
        expect(await openInSpa([fakeFile('districts.shp', shapefileBytes())]))
            .toContain('Shapefile');
    });

    it('recognizes a renamed shapefile by its header', async () => {
        expect(await openInSpa([fakeFile('geometry.bin', shapefileBytes())]))
            .toContain('Shapefile');
    });

    it('leaves the .shx index alone, byte-identical header and all', async () => {
        // The index carries the same file code and version as the geometry it
        // indexes, so only the name separates them — and it is the geometry the
        // viewer opens.
        const meta = await openInSpa([fakeFile('districts.shx', shapefileBytes())]);
        expect(meta).not.toContain('Shapefile');
        expect(meta).toContain('Raw Data');
    });

    it('does not claim a file whose version word is not 1000', async () => {
        const bytes = shapefileBytes();
        new DataView(bytes.buffer).setInt32(28, 1001, true);
        expect(await openInSpa([fakeFile('mystery.bin', bytes)])).toContain('Raw Data');
    });

    it('falls back to the .shp extension when the header is gone', async () => {
        expect(await openInSpa([fakeFile('truncated.shp', new Uint8Array(16))]))
            .toContain('Shapefile');
    });

    it('leads with the .shp when a whole set is opened together', async () => {
        // Whichever order the picker delivered them, the geometry is the file
        // to show and the `.dbf` / `.prj` ride along as its sidecars.
        const meta = await openInSpa([
            fakeFile('districts.dbf', bytesOf('\x03')),
            fakeFile('districts.prj', bytesOf('GEOGCS["WGS 84"]')),
            fakeFile('districts.shp', shapefileBytes())
        ]);
        expect(meta).toContain('districts.shp');
        expect(meta).toContain('Shapefile');
    });
});

describe('legacy SPA ExportedProgram detection', () => {
    it('routes a .pt2 package to the ExportedProgram viewer', async () => {
        expect(await openInSpa([fakeFile('resnet.pt2', pt2ArchiveBytes())]))
            .toContain('PyTorch ExportedProgram');
    });

    it('recognizes a renamed package by its archive_format marker', async () => {
        expect(await openInSpa([fakeFile('export.zip', pt2ArchiveBytes())]))
            .toContain('PyTorch ExportedProgram');
    });

    it('recognizes the marker under the folder an archive may wrap it in', async () => {
        expect(await openInSpa([fakeFile('export.zip', pt2ArchiveBytes('resnet/'))]))
            .toContain('PyTorch ExportedProgram');
    });

    it('recognizes the legacy serialized_exported_program.json layout', async () => {
        expect(await openInSpa([fakeFile('old.zip', legacyPt2ArchiveBytes())]))
            .toContain('PyTorch ExportedProgram');
    });

    it('leaves an archive without either marker as an archive', async () => {
        const bytes = zipBytes([{ name: 'notes.txt', data: bytesOf('no model here') }]);
        const meta = await openInSpa([fakeFile('bundle.zip', bytes)]);
        expect(meta).toContain('Archive');
        expect(meta).not.toContain('ExportedProgram');
    });

    it('falls back to the .pt2 extension when the archive header is gone', async () => {
        expect(await openInSpa([fakeFile('truncated.pt2', new Uint8Array(16))]))
            .toContain('PyTorch ExportedProgram');
    });
});
