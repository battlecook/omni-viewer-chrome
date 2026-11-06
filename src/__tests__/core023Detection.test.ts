import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
import { FileUtils, shortNameForViewType } from '../utils/fileUtils';
Object.assign(globalThis, { TextDecoder: NodeTextDecoder, TextEncoder: NodeTextEncoder });


function fakeFile(name: string, bytes: Uint8Array): File {
    return {
        name, size: bytes.length, type: 'application/octet-stream', lastModified: 1,
        slice: (start = 0, end = bytes.length) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
        arrayBuffer: async () => bytes.slice().buffer
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

describe('0.23.0 format detection in the SPA and FileUtils', () => {
    const bytes = (text: string) => new NodeTextEncoder().encode(text);
    const glb = () => {
        const json = bytes('{"asset":{"version":"2.0"}}');
        const length = Math.ceil(json.length / 4) * 4;
        const data = new Uint8Array(20 + length);
        data.fill(0x20, 20);
        data.set(bytes('glTF')); data.set(json, 20);
        const view = new DataView(data.buffer);
        view.setUint32(4, 2, true); view.setUint32(8, data.length, true);
        view.setUint32(12, length, true); view.setUint32(16, 0x4e4f534a, true);
        return data;
    };
    const api = JSON.stringify({ openapi: '3.2.0', info: { title: 'Example', version: '1' }, paths: {} });
    const cases: Array<[string, string | Uint8Array, string, string]> = [
        ['notes.TXT', '<script>alert(1)</script>  \n\tLiteral text', 'text', 'Text'],
        ['notes.txt', '{"log":{"entries":[]}}', 'text', 'Text'],
        ['notes.txt', '@startuml\nA -> B\n@enduml', 'text', 'Text'],
        ['empty.txt', '', 'text', 'Text'],
        ['report.xml', '<testsuites/>', 'junit', 'JUnit'],
        ['report.XML', '<?xml version="1.0"?><!-- hi --><testsuite tests="1"><testcase name="a"/></testsuite>', 'junit', 'JUnit'],
        ['report', '<testsuite><properties/></testsuite>', 'junit', 'JUnit'],
        ['api.json', api, 'openapi', 'OpenAPI / Swagger'],
        ['api.YAML', 'openapi: 3.1.0\ninfo:\n  title: Example\n  version: "1"\npaths: {}', 'openapi', 'OpenAPI / Swagger'],
        ['api.yml', '{openapi: 3.1.0, info: {title: Example, version: "1"}, paths: {}}', 'openapi', 'OpenAPI / Swagger'],
        ['api', 'swagger: "2.0"\ninfo: {"title":"API","version":"1"}\npaths: {}', 'openapi', 'OpenAPI / Swagger'],
        ['mail.eml', 'From: a@example.org\r\nTo: b@example.org\r\nSubject: Hello\r\n\r\nbody', 'eml', 'EML'],
        ['mail', 'From: a@example.org\r\nTo: b@example.org\r\nSubject: Hello\r\n\r\nbody', 'eml', 'EML'],
        ['scan.dcm', new Uint8Array([8, 0, 16, 0, 80, 78, 0, 0]), 'dicom', 'DICOM'],
        ['capture', new Uint8Array([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 13, 10]), 'mcap', 'MCAP'],
        ['capture.MCAP', new Uint8Array(), 'mcap', 'MCAP'],
        ['mesh.glb', glb(), 'mesh', '3D Mesh'],
        ['mesh', glb(), 'mesh', '3D Mesh'],
        ['mesh.GLTF', '{"asset":{"version":"2.0"}}', 'mesh', '3D Mesh'],
        ['mesh.stl', 'solid triangle\nendsolid', 'mesh', '3D Mesh'],
        ['mesh.OBJ', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3', 'mesh', '3D Mesh']
    ];
    it.each(cases)('routes %s to %s', async (name, payload, slug, label) => {
        const file = fakeFile(name, typeof payload === 'string' ? bytes(payload) : payload);
        expect(await openInSpa([file])).toContain(label);
        expect((await FileUtils.detectViewerType(file)).viewType).toBe(`omni-viewer.${slug}Viewer`);
    });

    it.each([
        ['ordinary.xml', '<testsuite><details/></testsuite>'],
        ['ordinary.xml', '<root><testsuites/></root>'],
        ['api.json', '{"openapi":"3.1.0","paths":{}}'],
        ['api.json', '{"openapi":"3.1.0","info":{"title":"A","version":"1"},"paths":{},"openapi":"3.1.0"}'],
        ['api.yaml', 'example:\n  openapi: 3.1.0\n  info: {title: Example, version: "1"}\n  paths: {}'],
        ['readme.md', api],
        ['scan.svg', '<testsuites/>'],
        ['report.arxml', '<testsuites/>'],
        ['email.yaml', 'From: a@example.org\nTo: b@example.org\nSubject: Hello\n\nbody']
    ])('keeps %s out of the specific document viewers', async (name, source) => {
        const file = fakeFile(name, bytes(source));
        expect(await openInSpa([file])).not.toMatch(/OpenAPI|JUnit|EML/);
        expect((await FileUtils.detectViewerType(file)).viewType ?? '').not.toMatch(/openapiViewer|junitViewer|emlViewer/);
    });

    it('refines a complete OpenAPI specification beyond the 64 KiB sniff window', async () => {
        const file = fakeFile('api.json', bytes(JSON.stringify({
            info: { title: 'Large API', version: '1', description: 'x'.repeat(70_000) },
            openapi: '3.1.0', paths: {}
        })));
        expect(await openInSpa([file])).toContain('OpenAPI');
        expect((await FileUtils.detectViewerType(file)).viewType).toBe('omni-viewer.openapiViewer');
    });

    it('recognizes a BOM-encoded JUnit XML report', async () => {
        const encoded = new Uint8Array([0xff, 0xfe, ...Array.from('<testsuites/>').flatMap(char => [char.charCodeAt(0), 0])]);
        const file = fakeFile('report.xml', encoded);
        expect(await openInSpa([file])).toContain('JUnit');
        expect((await FileUtils.detectViewerType(file)).viewType).toBe('omni-viewer.junitViewer');
    });

    it('keeps UTF-16 plain text out of audio detection', async () => {
        const file = fakeFile('notes.txt', new Uint8Array([0xff, 0xfe, 65, 0]));
        expect(await openInSpa([file])).toContain('Text');
        expect((await FileUtils.detectViewerType(file)).viewType).toBe('omni-viewer.textViewer');
    });

    it('detects DICOM Part 10 after an arbitrary preamble', async () => {
        const payload = new Uint8Array(140);
        payload.set(bytes('%PDF-')); payload.set(bytes('DICM'), 128);
        const file = fakeFile('scan', payload);
        expect(await openInSpa([file])).toContain('DICOM');
        expect((await FileUtils.detectViewerType(file)).viewType).toBe('omni-viewer.dicomViewer');
    });

    it.each([
        ['README.md', 'glTF is a 3D format', 'Markdown'],
        ['notes.txt', 'glTF supports meshes', 'Text'],
        ['data.csv', 'glTF,category\n1,2', 'CSV/TSV']
    ])('does not interpret a glTF prose prefix as GLB: %s', async (name, text, label) => {
        const file = fakeFile(name, bytes(text));
        expect(await openInSpa([file])).toContain(label);
        expect((await FileUtils.detectViewerType(file)).viewType).not.toBe('omni-viewer.meshViewer');
    });

    it.each(['version', 'length', 'truncated'])(
        'does not recognize an invalid GLB %s as a binary mesh', async (kind) => {
            let data = glb();
            const view = new DataView(data.buffer);
            if (kind === 'version') view.setUint32(4, 3, true);
            else if (kind === 'length') view.setUint32(8, data.length + 4, true);
            else data = data.slice(0, 4);
            const file = fakeFile('download.bin', data);
            expect(await openInSpa([file])).not.toContain('3D Mesh');
            expect((await FileUtils.detectViewerType(file)).viewType).not.toBe('omni-viewer.meshViewer');
        }
    );

    it('opens the glTF when its buffer was selected first', async () => {
        const buffer = fakeFile('data.bin', new Uint8Array([0, 1, 2]));
        const model = fakeFile('model.gltf', bytes('{"asset":{"version":"2.0"}}'));
        expect(await openInSpa([buffer, model])).toContain('3D Mesh');
        expect(document.querySelector('#fileMeta')?.textContent).toContain('model.gltf');
    });
});
