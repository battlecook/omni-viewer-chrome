// Detection coverage for the viewer that actually ships.
//
// `src/app.js` is the legacy SPA loaded by viewer.html, and its own
// `detectType` — not `src/utils/fileUtils.ts` — is what routes a real file to
// the XML and EPUB viewers. These cases drive app.js end to end
// (launchQueue -> openFile -> detectType) and assert on the format label it
// renders into #fileMeta.
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

function bytesOf(text: string): Uint8Array {
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
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

/** An OCF container: the stored `mimetype` member first, then the package. */
function epubBytes(mimetype = 'application/epub+zip'): Uint8Array {
    return zipBytes([
        { name: 'mimetype', data: bytesOf(mimetype) },
        {
            name: 'META-INF/container.xml',
            data: bytesOf('<?xml version="1.0"?><container version="1.0"/>')
        }
    ]);
}

describe('legacy SPA XML detection', () => {
    it.each(['pom.xml', 'schema.xsd', 'feed.rss', 'route.gpx', 'App.csproj'])(
        'routes %s to the XML viewer by extension',
        async (name) => {
            const meta = await openInSpa([
                fakeFile(name, bytesOf('<?xml version="1.0"?><project><modules/></project>'))
            ]);
            expect(meta).toContain('XML');
            expect(meta).not.toContain('Raw Data');
        }
    );

    it('recognizes an extensionless document by its prolog and root', async () => {
        const text = '\ufeff<?xml version="1.0"?>\n<!-- generated -->\n<!DOCTYPE note [<!ENTITY a "b">]>\n<note/>';
        expect(await openInSpa([fakeFile('download', new NodeTextEncoder().encode(text))]))
            .toContain('XML');
    });

    it('claims attribute-heavy and bare-text XML that FileUtils would guess otherwise', async () => {
        const tomlLike = '<?xml version="1.0"?>\n<root\n  alpha="1"\n  beta="2"\n  gamma="3">\n</root>';
        expect(await openInSpa([fakeFile('data', bytesOf(tomlLike))])).toContain('XML');
        expect(await openInSpa([fakeFile('notes', bytesOf('<doc>\nstart here\n</doc>'))])).toContain('XML');
    });

    it('does not claim HTML, which is rarely well-formed', async () => {
        const meta = await openInSpa([
            fakeFile('page', bytesOf('<!DOCTYPE html><html><body><p>hi</body></html>'))
        ]);
        expect(meta).toContain('Raw Data');
    });

    it('keeps the dialects with their own viewer by extension', async () => {
        // ARXML is XML too, but a trusted extension always wins over content.
        const meta = await openInSpa([
            fakeFile('system.arxml', bytesOf('<?xml version="1.0"?><AUTOSAR><AR-PACKAGES/></AUTOSAR>'))
        ]);
        expect(meta).toContain('Automotive');
    });
});

describe('legacy SPA EPUB detection', () => {
    it('routes a .epub to the EPUB reader', async () => {
        expect(await openInSpa([fakeFile('alice.epub', epubBytes())])).toContain('EPUB');
    });

    it('recognizes a renamed book by its stored mimetype member', async () => {
        expect(await openInSpa([fakeFile('download.zip', epubBytes())])).toContain('EPUB');
        expect(await openInSpa([fakeFile('download', epubBytes())])).toContain('EPUB');
    });

    it('finds the mimetype member wherever `zip -r` put it', async () => {
        const bytes = zipBytes([
            { name: 'META-INF/container.xml', data: bytesOf('<container/>') },
            { name: 'OEBPS/content.opf', data: bytesOf('<package/>') },
            { name: 'mimetype', data: bytesOf('application/epub+zip') }
        ]);
        expect(await openInSpa([fakeFile('book', bytes)])).toContain('EPUB');
    });

    it('leaves a ZIP with another mimetype to the other viewers', async () => {
        const meta = await openInSpa([
            fakeFile('notes.zip', epubBytes('application/vnd.oasis.opendocument.text'))
        ]);
        expect(meta).toContain('Archive');
        expect(meta).not.toContain('EPUB');
    });

    it('falls back to the .epub extension when the archive header is gone', async () => {
        expect(await openInSpa([fakeFile('truncated.epub', new Uint8Array(16))]))
            .toContain('EPUB');
    });
});
