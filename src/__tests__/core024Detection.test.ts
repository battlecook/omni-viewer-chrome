import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
import { FileUtils } from '../utils/fileUtils';
Object.assign(globalThis, { TextDecoder: NodeTextDecoder, TextEncoder: NodeTextEncoder });

const bytes = (text: string) => new NodeTextEncoder().encode(text);

function fakeFile(name: string, data: Uint8Array): File {
    return {
        name, size: data.length, type: 'application/octet-stream', lastModified: 1,
        slice: (start = 0, end = data.length) => ({ arrayBuffer: async () => data.slice(start, end).buffer }),
        arrayBuffer: async () => data.slice().buffer
    } as unknown as File;
}

/** A ZIP of stored members with the central directory the core probe reads. */
function zip(entries: Array<[name: string, data?: string]>): Uint8Array {
    const local: number[] = [];
    const central: number[] = [];
    const u16 = (value: number) => [value & 0xff, value >>> 8];
    const u32 = (value: number) => [...u16(value & 0xffff), ...u16(value >>> 16)];
    for (const [name, data = ''] of entries) {
        const offset = local.length;
        const sizes = [...u32(0), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
        local.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u32(0), ...sizes, ...bytes(name), ...bytes(data));
        central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u32(0), ...sizes,
            ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...bytes(name));
    }
    return Uint8Array.from([...local, ...central, ...u32(0x06054b50), ...u16(0), ...u16(0),
        ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(local.length), ...u16(0)]);
}

/** A compound file whose root storage holds the named, empty streams. */
function compoundFile(streams: string[]): Uint8Array {
    const data = new Uint8Array(512 * 3);
    const view = new DataView(data.buffer);
    data.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    view.setUint16(24, 0x3e, true); view.setUint16(26, 3, true); view.setUint16(28, 0xfffe, true);
    view.setUint16(30, 9, true); view.setUint16(32, 6, true);
    view.setUint32(44, 1, true);            // one FAT sector …
    view.setUint32(48, 1, true);            // … then the directory sector
    view.setUint32(56, 4096, true);
    view.setUint32(60, 0xfffffffe, true); view.setUint32(68, 0xfffffffe, true);
    for (let index = 0; index < 109; index++) view.setUint32(76 + index * 4, index ? 0xffffffff : 0, true);
    for (let index = 0; index < 128; index++) view.setUint32(512 + index * 4, 0xffffffff, true);
    view.setUint32(512, 0xfffffffd, true); view.setUint32(516, 0xfffffffe, true);
    ['Root Entry', ...streams].forEach((name, index) => {
        const entry = 1024 + index * 128;
        Array.from(name).forEach((char, at) => view.setUint16(entry + at * 2, char.charCodeAt(0), true));
        view.setUint16(entry + 64, (name.length + 1) * 2, true);
        data[entry + 66] = index ? 2 : 5;
        data[entry + 67] = 1;
        // The streams hang off the root as a right-leaning sibling chain.
        view.setUint32(entry + 68, 0xffffffff, true);
        view.setUint32(entry + 72, index && index < streams.length ? index + 1 : 0xffffffff, true);
        view.setUint32(entry + 76, !index && streams.length ? 1 : 0xffffffff, true);
        view.setUint32(entry + 116, 0xfffffffe, true);
    });
    return data;
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
    Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: NodeTextDecoder });

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

describe('0.24.0 format detection in the SPA and FileUtils', () => {
    const sarif = JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'lint' } }, results: [] }] });
    const sbom = JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [] });
    const trace = JSON.stringify({ traceEvents: [{ name: 'task', ph: 'X', pid: 1, tid: 1, ts: 0, dur: 5 }] });
    const gpx = '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="1" lon="2"/></gpx>';
    const kml = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>';
    const drawio = '<mxfile host="app.diagrams.net"><diagram name="Page-1"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>';
    const message = compoundFile(['__properties_version1.0', '__substg1.0_001A001F']);
    const odt = zip([['mimetype', 'application/vnd.oasis.opendocument.text'], ['content.xml', '<office:document-content/>']]);
    const kmz = zip([['doc.kml', kml]]);

    const cases: Array<[string, string | Uint8Array, string, string]> = [
        ['scan.sarif', sarif, 'sarif', 'SARIF'],
        ['scan.SARIF.json', sarif, 'sarif', 'SARIF'],
        ['scan.json', sarif, 'sarif', 'SARIF'],
        ['scan', sarif, 'sarif', 'SARIF'],
        ['bom.cdx.json', sbom, 'sbom', 'CycloneDX SBOM'],
        ['bom.cyclonedx.json', '{}', 'sbom', 'CycloneDX SBOM'],
        ['bom.json', sbom, 'sbom', 'CycloneDX SBOM'],
        ['profile.trace.json', trace, 'trace', 'Performance Trace'],
        ['profile.chrome-trace', trace, 'trace', 'Performance Trace'],
        ['profile.json', trace, 'trace', 'Performance Trace'],
        ['route.gpx', gpx, 'gps', 'GPS Map'],
        ['places.KML', kml, 'gps', 'GPS Map'],
        ['route.xml', gpx, 'gps', 'GPS Map'],
        ['route', kml, 'gps', 'GPS Map'],
        ['plain.kml', '<kml><Document/></kml>', 'gps', 'GPS Map'],
        ['prefixed.gpx', '\ufeff<?xml version="1.0"?>\n<!DOCTYPE g [<!ENTITY a "b>">]><g:gpx xmlns:g="http://www.topografix.com/GPX/1/0"/>', 'gps', 'GPS Map'],
        ['empty.kml', '', 'gps', 'GPS Map'],
        ['places.kmz', kmz, 'gps', 'GPS Map'],
        ['places', kmz, 'gps', 'GPS Map'],
        ['flow.drawio', drawio, 'drawio', 'draw.io'],
        ['flow.dio', drawio, 'drawio', 'draw.io'],
        ['flow.xml', drawio, 'drawio', 'draw.io'],
        ['mail.msg', message, 'msg', 'Outlook Message'],
        ['mail', message, 'msg', 'Outlook Message'],
        ['letter.odt', odt, 'opendocument', 'OpenDocument'],
        ['slides.ODP', zip([['content.xml']]), 'opendocument', 'OpenDocument'],
        ['letter', odt, 'opendocument', 'OpenDocument']
    ];
    it.each(cases)('routes %s to %s', async (name, payload, slug, label) => {
        const file = fakeFile(name, typeof payload === 'string' ? bytes(payload) : payload);
        expect(await openInSpa([file])).toContain(label);
        expect((await FileUtils.detectViewerType(file)).viewType).toBe(`omni-viewer.${slug}Viewer`);
    });

    it.each<[string, string | Uint8Array]>([
        ['data.json', '{"version":"2.1.0","name":"package"}'],
        ['pom.xml', '<project><gpx/></project>'],
        ['route.xml', '<gpx xmlns="https://example.org/other"/>'],
        ['feed.rss', gpx],
        ['notes.md', sarif],
        ['Pose.msg', 'float64 x\nfloat64 y\n'],
        ['sheet.xls', compoundFile(['Workbook'])],
        ['unknown', compoundFile(['Contents'])],
        ['bundle.zip', kmz],
        ['bundle', zip([['a.kml', kml], ['b.kml', kml]])],
        ['bundle', zip([['readme.txt', 'plain']])]
    ])('keeps %s out of the preview viewers', async (name, payload) => {
        const file = fakeFile(name, typeof payload === 'string' ? bytes(payload) : payload);
        expect(await openInSpa([file])).not.toMatch(/SARIF|SBOM|Trace|GPS|draw\.io|Outlook|OpenDocument/);
        expect((await FileUtils.detectViewerType(file)).viewType ?? '')
            .not.toMatch(/sarif|sbom|trace|gps|drawio|msg|opendocument/);
    });

    it.each([
        ['places.kml', '<kml xmlns="http://www.opengis.net/kml/2.3"><Placemark/></kml>'],
        ['route.gpx', '<?xml version="1.0"?><!-- x --><gpx xmlns="https://example.org/gpx"/>'],
        ['route.gpx', '<g:gpx xmlns:g="https://example.org/gpx" xmlns="http://www.topografix.com/GPX/1/1"/>'],
        ['notes.kml', '<project/>'],
        ['places.kml', '<kmlx xmlns="http://www.opengis.net/kml/2.2"/>'],
        ['places.kml', '<?xml version="1.0"?>\n<!---> generated -->\n<kml xmlns="http://www.opengis.net/kml/2.3"/>'],
        ['route.gpx', '<a.b:gpx xmlns:aXb="http://www.topografix.com/GPX/1/1" xmlns:a.b="https://example.org/x"/>']
    ])('keeps %s outside the GPS dialects in the XML viewer', async (name, source) => {
        const file = fakeFile(name, bytes(source));
        const meta = await openInSpa([file]);
        expect(meta).toContain('XML');
        expect(meta).not.toContain('GPS');
        expect((await FileUtils.detectViewerType(file)).viewType).toBe('omni-viewer.xmlViewer');
    });

    it('scans a hostile DOCTYPE in linear time', () => {
        const { acceptsGpsDocument } = jest.requireActual('../utils/documentDetection.js');
        const started = Date.now();
        for (const text of ['<!DOCTYPE ' + '[]'.repeat(40), '<!DOCTYPE [' + ']'.repeat(60_000), '<!--'.repeat(16_000)]) {
            expect(acceptsGpsDocument(bytes(text))).toBe(true);
        }
        expect(Date.now() - started).toBeLessThan(500);
    });

    it('does not read an oversized container to probe it', async () => {
        const file = fakeFile('places', kmz);
        Object.defineProperty(file, 'size', { value: 32 * 1024 * 1024 + 1 });
        const read = jest.spyOn(file, 'arrayBuffer');
        expect(await openInSpa([file])).not.toContain('GPS');
        expect(read).not.toHaveBeenCalled();
        // FileUtils' Office ZIP scan reads the file on its own, so only the
        // routing is asserted there.
        expect((await FileUtils.detectViewerType(file)).viewType).not.toBe('omni-viewer.gpsViewer');
    });

    it('falls through when the whole container cannot be read', async () => {
        const file = fakeFile('places', kmz);
        jest.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('NotReadableError'));
        expect(await openInSpa([file])).not.toContain('GPS');
        expect((await FileUtils.detectViewerType(file)).viewType).not.toBe('omni-viewer.gpsViewer');
    });
});
