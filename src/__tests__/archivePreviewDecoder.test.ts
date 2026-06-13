// jest-environment-jsdom@29 does not expose TextEncoder/TextDecoder as
// globals. Polyfill from node:util before importing the module under test
// so its lazy decoders pick them up.
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof NodeTextEncoder }).TextEncoder = NodeTextEncoder;
}
if (typeof (globalThis as { TextDecoder?: unknown }).TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof NodeTextDecoder }).TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;
}

import { tryDecodeArchiveEntryPreview } from '../utils/fileUtils/archivePreviewDecoder';

/**
 * Browser port of the upstream archivePreviewDecoder test.
 * All Buffer fixtures are rewritten as Uint8Array so the test runs cleanly
 * under the Chrome-extension target (no node:Buffer dependency leaks).
 */

describe('archive preview decoder', () => {
    it('falls back for plain text files', () => {
        const result = tryDecodeArchiveEntryPreview('notes.txt', new TextEncoder().encode('hello'));
        expect(result).toBeNull();
    });

    it('decodes Android binary XML into readable text', () => {
        const result = tryDecodeArchiveEntryPreview('AndroidManifest.xml', createBinaryXmlFixture());

        expect(result).not.toBeNull();
        expect(result?.description).toContain('Android binary XML');
        expect(result?.content).toContain('<manifest');
        expect(result?.content).toContain('package="com.example.app"');
        expect(result?.content).toContain('</manifest>');
    });
});

function createBinaryXmlFixture(): Uint8Array {
    const manifestName = encodeUtf8PoolString('manifest');
    const packageName = encodeUtf8PoolString('package');
    const packageValue = encodeUtf8PoolString('com.example.app');
    const stringData = alignTo4(concat(manifestName, packageName, packageValue));
    const stringOffsets = new Uint8Array(12);
    writeU32Into(stringOffsets, 0, 0);
    writeU32Into(stringOffsets, 4, manifestName.length);
    writeU32Into(stringOffsets, 8, manifestName.length + packageName.length);

    const stringPoolChunkSize = 28 + stringOffsets.length + stringData.length;
    const stringPoolChunk = concat(
        createChunkHeader(0x0001, 28, stringPoolChunkSize),
        writeU32(3),
        writeU32(0),
        writeU32(0x00000100),
        writeU32(28 + stringOffsets.length),
        writeU32(0),
        stringOffsets,
        stringData
    );

    const startElementChunk = concat(
        createChunkHeader(0x0102, 36, 56),
        writeU32(1),
        writeU32(0xFFFFFFFF),
        writeU32(0xFFFFFFFF),
        writeU32(0),
        writeU16(20),
        writeU16(20),
        writeU16(1),
        writeU16(0),
        writeU16(0),
        writeU16(0),
        writeU32(0xFFFFFFFF),
        writeU32(1),
        writeU32(2),
        writeU16(8),
        new Uint8Array([0x00, 0x03]),
        writeU32(2)
    );

    const endElementChunk = concat(
        createChunkHeader(0x0103, 24, 24),
        writeU32(1),
        writeU32(0xFFFFFFFF),
        writeU32(0xFFFFFFFF),
        writeU32(0)
    );

    const body = concat(stringPoolChunk, startElementChunk, endElementChunk);
    const xmlHeader = createChunkHeader(0x0003, 8, 8 + body.length);
    return concat(xmlHeader, body);
}

function createChunkHeader(type: number, headerSize: number, size: number): Uint8Array {
    return concat(writeU16(type), writeU16(headerSize), writeU32(size));
}

function encodeUtf8PoolString(value: string): Uint8Array {
    const utf8 = new TextEncoder().encode(value);
    return concat(new Uint8Array([value.length, utf8.length]), utf8, new Uint8Array([0x00]));
}

function alignTo4(buffer: Uint8Array): Uint8Array {
    const remainder = buffer.length % 4;
    if (remainder === 0) {
        return buffer;
    }
    return concat(buffer, new Uint8Array(4 - remainder));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const arr of arrays) {
        out.set(arr, offset);
        offset += arr.length;
    }
    return out;
}

function writeU16(value: number): Uint8Array {
    const buffer = new Uint8Array(2);
    new DataView(buffer.buffer).setUint16(0, value & 0xFFFF, true);
    return buffer;
}

function writeU32(value: number): Uint8Array {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setUint32(0, value >>> 0, true);
    return buffer;
}

function writeU32Into(buffer: Uint8Array, offset: number, value: number): void {
    new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(offset, value >>> 0, true);
}
