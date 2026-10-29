import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FileUtils, shortNameForViewType } from '../utils/fileUtils';
Object.assign(globalThis, { TextDecoder: NodeTextDecoder, TextEncoder: NodeTextEncoder });
const { tableFromArrays, tableToIPC } = require('apache-arrow') as typeof import('apache-arrow');

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

describe('0.22.0 viewer routing in the SPA and FileUtils', () => {
    const bytes = (source: string) => new NodeTextEncoder().encode(source);
    const fontBytes = (extension: string) => new Uint8Array(readFileSync(
        resolve(__dirname, `../../node_modules/katex/dist/fonts/KaTeX_Main-Regular.${extension}`)
    ));
    const sfntBytes = (signature: string) => fontBytes('ttf')
        .map((byte, index) => index < 4 ? signature.charCodeAt(index) : byte);
    const arrowTable = tableFromArrays({ city: ['Seoul', 'Busan'], population: [9, 3] });

    it.each([
        ['font.TTF', new Uint8Array([0, 1, 0, 0]), 'font', 'Font'],
        ['font.bin', sfntBytes('OTTO'), 'font', 'Font'],
        ['font', sfntBytes('true'), 'font', 'Font'],
        ['webfont.bin', fontBytes('woff'), 'font', 'Font'],
        ['font.otf', bytes('broken'), 'font', 'Font'],
        ['font.woff', bytes('broken'), 'font', 'Font'],
        ['table.bin', tableToIPC(arrowTable, 'file'), 'arrow', 'Arrow / Feather'],
        ['table', tableToIPC(arrowTable, 'stream'), 'arrow', 'Arrow / Feather'],
        ['table.FEATHER', bytes('broken'), 'arrow', 'Arrow / Feather'],
        ['table.arrow', new Uint8Array(), 'arrow', 'Arrow / Feather'],
        ['map.geojson', bytes('{"type":"Point","coordinates":[127,37]}'), 'geojson', 'GeoJSON'],
        ['map', bytes('{"type":"FeatureCollection","features":[]}'), 'geojson', 'GeoJSON'],
        ['map.json', bytes('{"type":"Point","coordinates":[127,37]}'), 'geojson', 'GeoJSON'],
        ['map', bytes('{"type":"Feature","geometry":null,"properties":null}'), 'geojson', 'GeoJSON'],
        ['map', bytes('{"geometries":[],"type":"GeometryCollection"}'), 'geojson', 'GeoJSON'],
        ['map.GEOJSON', bytes('broken'), 'geojson', 'GeoJSON'],
        ['drawing.geojson', bytes('{"type":"Feature","geometry":null,"properties":{"icon":"<svg></svg>"}}'), 'geojson', 'GeoJSON'],
        ['blank.geojson', new Uint8Array(), 'geojson', 'GeoJSON']
    ])('routes %s to %s', async (name, head, slug, label) => {
        const file = fakeFile(name, head);
        expect(await openInSpa([file])).toContain(label);
        expect((await FileUtils.detectViewerType(file)).viewType).toBe(`omni-viewer.${slug}Viewer`);
        expect(shortNameForViewType(`omni-viewer.${slug}Viewer` as Parameters<typeof shortNameForViewType>[0])).toBe(slug);
    });

    it.each(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'])(
        'recognizes a truncated %s coordinate array within the sniff window', async (type) => {
            const file = fakeFile('map', bytes(`{"type":"${type}","coordinates":[[127,37],`), 100_000);
            expect(await openInSpa([file])).toContain('GeoJSON');
            expect((await FileUtils.detectViewerType(file)).viewType).toBe('omni-viewer.geojsonViewer');
        }
    );

    it.each([
        '{"payload":{"type":"Point","coordinates":[1,2]}}',
        '{"type":"Point","nested":{"coordinates":[]}}',
        '{"type":"FeatureCollection","features":null}',
        '{"type":"Feature","geometry":{},"properties":[]}',
        '{"type":"NotPoint","coordinates":[]}',
        '{"type":"Point","coordinates":"[]"}'
    ])('does not misclassify ordinary JSON: %s', async (source) => {
        const file = fakeFile('data.json', bytes(source));
        expect(await openInSpa([file])).not.toContain('GeoJSON');
        expect((await FileUtils.detectViewerType(file)).viewType).toBe('omni-viewer.jsonViewer');
    });

    it.each([
        ['README.md', 'true story about this project', 'Markdown'],
        ['README.md', 'OTTO is a document viewer', 'Markdown'],
        ['data.csv', 'OTTO,category\n1,2', 'CSV/TSV'],
        ['README.md', 'wOFF is a font format', 'Markdown'],
        ['config.json', 'true', 'JSON'],
        ['page.html', 'true<p>some text</p>', 'HTML']
    ])('keeps text starting with an ASCII font signature in its declared viewer: %s', async (name, source, label) => {
        const file = fakeFile(name, bytes(source));
        expect(await openInSpa([file])).toContain(label);
        expect((await FileUtils.detectViewerType(file)).viewType).not.toBe('omni-viewer.fontViewer');
    });

    it('does not treat a continuation marker alone as an Arrow schema', async () => {
        const file = fakeFile('capture.bin', new Uint8Array([255, 255, 255, 255, ...new Array(28).fill(0)]));
        expect(await openInSpa([file])).not.toContain('Arrow / Feather');
        expect((await FileUtils.detectViewerType(file)).viewType).not.toBe('omni-viewer.arrowViewer');
    });

    it.each(['image.geojson', 'image.ttf', 'image.feather'])(
        'preserves a PNG signature over the extension of %s', async (name) => {
            const file = fakeFile(name, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
            expect(await openInSpa([file])).toContain('Image');
            expect((await FileUtils.detectViewerType(file)).viewType).toBe('omni-viewer.imageViewer');
        }
    );

    it('keeps a recognized document extension ahead of a GeoJSON example', async () => {
        const file = fakeFile('notes.md', bytes('{"type":"Point","coordinates":[127,37]}'));
        expect(await openInSpa([file])).toContain('Markdown');
        expect((await FileUtils.detectViewerType(file)).viewType).not.toBe('omni-viewer.geojsonViewer');
    });
});
