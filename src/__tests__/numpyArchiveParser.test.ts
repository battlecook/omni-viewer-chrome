jest.mock('omni-viewer-core/parsers/numpy', () => ({
    formatFileSize: (bytes: number) => `${bytes} bytes`,
    parseNpy: jest.fn((data: Uint8Array, name: string) => {
        if (
            data.byteLength < 10 || data[0] !== 0x93 || data[1] !== 0x4e ||
            data[2] !== 0x55 || data[3] !== 0x4d || data[4] !== 0x50 || data[5] !== 0x59
        ) return { arrays: [] };
        const headerLength = new DataView(data.buffer, data.byteOffset, data.byteLength)
            .getUint16(8, true);
        const header = String.fromCharCode(...data.subarray(10, 10 + headerLength));
        const payload = data.subarray(10 + headerLength);
        const dtype = header.match(/["']descr["']\s*:\s*(["'])(.*?)\1/)?.[2] ?? '|u1';
        const shapeText = header.match(/["']shape["']\s*:\s*\(([^)]*)\)/)?.[1] ?? '';
        const shape = shapeText.split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .map(Number);
        const elements = shape.length ? shape.reduce((product, value) => product * value, 1) : 1;
        const stringWidth = Number(dtype.match(/[SU](\d+)/)?.[1] ?? 0);
        const itemBytes = dtype.includes('U') ? stringWidth * 4 : stringWidth || 1;
        const payloadShort = payload.byteLength < elements * itemBytes;
        return {
            arrays: [{
                name,
                dtype,
                byteOrder: 'not-applicable',
                kind: stringWidth ? 'byte string' : 'unsigned integer',
                shape,
                fortranOrder: false,
                elements,
                byteLength: payload.length,
                values: payloadShort
                    ? []
                    : stringWidth
                        ? ['x'.repeat(stringWidth)]
                        : Array.from(payload),
                previewTruncated: payloadShort,
                warnings: payloadShort ? ['The array payload is shorter than required.'] : [],
                diagnostics: payloadShort ? [{ code: 'payloadShort' }] : []
            }]
        };
    })
}));

import JSZip from 'jszip';
import {
    parseNumpyArchiveSafely,
    parseNumpyFileSafely
} from '../templates/numpy/js/numpyArchiveParser';

const parserCore = jest.requireMock('omni-viewer-core/parsers/numpy') as {
    parseNpy: jest.Mock;
};

function makeNpy(values: Uint8Array): Uint8Array {
    const prefixLength = 10;
    const dictionary = `{'descr': '|u1', 'fortran_order': False, 'shape': (${values.length},), }`;
    const padding = (16 - ((prefixLength + dictionary.length + 1) % 16)) % 16;
    const header = Uint8Array.from(
        `${dictionary}${' '.repeat(padding)}\n`,
        (character) => character.charCodeAt(0)
    );
    const result = new Uint8Array(prefixLength + header.length + values.length);
    result.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
    new DataView(result.buffer).setUint16(8, header.length, true);
    result.set(header, prefixLength);
    result.set(values, prefixLength + header.length);
    return result;
}

function makeStringNpy(
    itemBytes: number,
    suffix = '',
    shapeCount = 1,
    payloadBytes = itemBytes * shapeCount
): Uint8Array {
    const prefixLength = 10;
    const dictionary = `{'descr': '|S${itemBytes}${suffix}', 'fortran_order': False, 'shape': (${shapeCount},), }`;
    const padding = (16 - ((prefixLength + dictionary.length + 1) % 16)) % 16;
    const header = Uint8Array.from(
        `${dictionary}${' '.repeat(padding)}\n`,
        (character) => character.charCodeAt(0)
    );
    const result = new Uint8Array(prefixLength + header.length + payloadBytes);
    result.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
    new DataView(result.buffer).setUint16(8, header.length, true);
    result.set(header, prefixLength);
    return result;
}

async function makeArchive(files: Array<[string, Uint8Array]>): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [name, bytes] of files) zip.file(name, bytes);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('bounded NumPy archive parser', () => {
    it('renders a valid empty NPZ as an empty archive', async () => {
        const data = await makeArchive([]);

        const document = await parseNumpyArchiveSafely(data);

        expect(document.format).toBe('NumPy NPZ');
        expect(document.arrays).toEqual([]);
        expect(document.warnings).toContain('The NPZ archive does not contain any .npy arrays.');
    });

    it('caps preview values across the whole document', async () => {
        const data = await makeArchive([
            ['a.npy', makeNpy(new Uint8Array(60).fill(1))],
            ['b.npy', makeNpy(new Uint8Array(60).fill(2))]
        ]);

        const document = await parseNumpyArchiveSafely(data, {
            maxArrays: 10,
            maxEntryBytes: 1024,
            maxTotalBytes: 2048,
            previewElements: 100
        });

        expect(document.arrays.map((array) => array.values.length)).toEqual([60, 40]);
        expect(document.arrays[1]?.previewTruncated).toBe(true);
        expect(document.arrays.flatMap((array) => array.values)).toHaveLength(100);
    });

    it('limits the actual inflated stream instead of trusting declared sizes', async () => {
        const data = await makeArchive([['large.npy', makeNpy(new Uint8Array(64))]]);

        const document = await parseNumpyArchiveSafely(data, {
            maxArrays: 10,
            maxEntryBytes: 32,
            maxTotalBytes: 1024,
            previewElements: 100
        });

        expect(document.arrays).toEqual([]);
        expect(document.warnings.join(' ')).toContain('exceeds the 32 bytes safety limit');
    });

    it('turns excessive NPY rank into a bounded metadata-only model', async () => {
        parserCore.parseNpy.mockReturnValueOnce({
            arrays: [{
                name: 'rank-bomb',
                dtype: '|u1',
                byteOrder: 'not-applicable',
                kind: 'unsigned integer',
                shape: new Array(20_000).fill(1),
                fortranOrder: false,
                elements: 1,
                byteLength: 1,
                values: [7],
                previewTruncated: false,
                warnings: []
            }]
        });

        const document = await parseNumpyFileSafely(makeNpy(new Uint8Array([7])), 'rank.npy');

        expect(document.arrays[0]?.shape).toHaveLength(64);
        expect(document.arrays[0]?.values).toEqual([]);
        expect(document.arrays[0]?.previewTruncated).toBe(true);
        expect(document.warnings.join(' ')).toContain('64-axis rendering safety limit');
    });

    it('does not ask core to allocate an oversized fixed-width string preview', async () => {
        parserCore.parseNpy.mockClear();

        const document = await parseNumpyFileSafely(makeStringNpy(600_000), 'strings.npy');

        expect(parserCore.parseNpy).toHaveBeenCalledTimes(1);
        expect((parserCore.parseNpy.mock.calls[0]?.[0] as Uint8Array).byteLength)
            .toBeLessThan(makeStringNpy(600_000).byteLength);
        expect(document.arrays[0]).toEqual(expect.objectContaining({
            dtype: '|S600000',
            shape: [1],
            values: [],
            previewTruncated: true
        }));
        expect(document.warnings.join(' ')).toContain('1,000,000-character safety limit');
    });

    it('applies string limits to dtype suffixes accepted by core', async () => {
        parserCore.parseNpy.mockClear();

        const document = await parseNumpyFileSafely(
            makeStringNpy(600_000, '[suffix]'),
            'strings.npy'
        );

        expect(parserCore.parseNpy).toHaveBeenCalledTimes(1);
        expect(document.arrays[0]?.dtype).toBe('|S600000[suffix]');
        expect(document.arrays[0]?.values).toEqual([]);
    });

    it('shares the string preview budget across all NPZ arrays', async () => {
        parserCore.parseNpy.mockClear();
        const data = await makeArchive([
            ['a.npy', makeStringNpy(400_000)],
            ['b.npy', makeStringNpy(400_000)]
        ]);

        const document = await parseNumpyArchiveSafely(data);

        expect(parserCore.parseNpy).toHaveBeenCalledTimes(2);
        expect(document.arrays).toHaveLength(2);
        expect(document.arrays[1]?.values).toEqual([]);
        expect(document.arrays[1]?.warnings.join(' ')).toContain('document text');
    });

    it('warns when an NPY member is invalid instead of silently dropping it', async () => {
        const data = await makeArchive([['bad.npy', new Uint8Array([1, 2, 3, 4])]]);

        const document = await parseNumpyArchiveSafely(data);

        expect(document.arrays).toEqual([]);
        expect(document.warnings.join(' ')).toContain('bad.npy: the NPY member is invalid');
    });

    it('bounds ZIP member names before cloning them into the renderer model', async () => {
        const longName = `${'nested/'.repeat(140)}array.npy`;
        const data = await makeArchive([[longName, makeNpy(new Uint8Array([1]))]]);

        const document = await parseNumpyArchiveSafely(data);

        expect(document.arrays[0]?.name.length).toBeLessThanOrEqual(256);
        expect(document.tables[0]?.rows[0]?.[0]).toBe(document.arrays[0]?.name);
    });

    it('bounds core metadata before repeating it in summary and tables', async () => {
        const hugeDtype = `|V1[${'x'.repeat(200_000)}]`;
        parserCore.parseNpy.mockReturnValueOnce({
            arrays: [{
                name: 'metadata',
                dtype: hugeDtype,
                byteOrder: 'not-applicable',
                kind: 'unknown',
                shape: [1],
                fortranOrder: false,
                elements: 1,
                byteLength: 1,
                values: [],
                previewTruncated: false,
                warnings: [`Values with dtype ${hugeDtype} are not decoded.`]
            }]
        });

        const document = await parseNumpyFileSafely(makeNpy(new Uint8Array([1])), 'meta.npy');

        expect(document.arrays[0]?.dtype.length).toBeLessThanOrEqual(256);
        expect(document.arrays[0]?.warnings[0]?.length).toBeLessThanOrEqual(512);
        expect(JSON.stringify(document).length).toBeLessThan(5000);
    });

    it('does not let the metadata fast path accept a missing NPY magic signature', async () => {
        const corrupt = makeStringNpy(600_000);
        corrupt.fill(0, 0, 6);
        parserCore.parseNpy.mockClear();
        const data = await makeArchive([['corrupt.npy', corrupt]]);

        const document = await parseNumpyArchiveSafely(data);

        expect(parserCore.parseNpy).toHaveBeenCalledTimes(1);
        expect(document.arrays).toEqual([]);
        expect(document.warnings.join(' ')).toContain('corrupt.npy: the NPY member is invalid');
    });

    it('keeps core header-grammar diagnostics on the oversized-string path', async () => {
        parserCore.parseNpy.mockReturnValueOnce({
            arrays: [{
                name: 'duplicate',
                dtype: 'unknown',
                byteOrder: 'not-applicable',
                kind: 'unknown',
                shape: [],
                fortranOrder: false,
                elements: 0,
                byteLength: 0,
                values: [],
                previewTruncated: false,
                warnings: ['The NPY header contains duplicate fields.'],
                diagnostics: [{ code: 'npyHeaderGrammar' }]
            }]
        });

        const document = await parseNumpyFileSafely(makeStringNpy(600_000), 'duplicate.npy');

        expect(document.arrays[0]?.dtype).toBe('unknown');
        expect(document.diagnostics).toEqual([{ code: 'npyHeaderGrammar', args: {} }]);
    });

    it('recomputes real payload bounds after header-only string validation', async () => {
        const document = await parseNumpyFileSafely(
            makeStringNpy(600_000, '', 2, 600_000),
            'short.npy'
        );

        expect(document.diagnostics?.map((item) => item.code)).toEqual(
            expect.arrayContaining(['payloadShort', 'textPreviewLimit'])
        );
        expect(document.diagnostics?.find((item) => item.code === 'textPreviewLimit')?.args)
            .toEqual({ perValue: 4096, total: 1_000_000 });
    });

    it('does not let an invalid header consume the document string budget', async () => {
        parserCore.parseNpy.mockReturnValueOnce({
            arrays: [{
                name: 'invalid', dtype: 'unknown', byteOrder: 'not-applicable', kind: 'unknown',
                shape: [], fortranOrder: false, elements: 0, byteLength: 0, values: [],
                previewTruncated: false, warnings: ['Invalid header.'],
                diagnostics: [{ code: 'npyHeaderGrammar' }]
            }]
        });
        const data = await makeArchive([
            ['a-invalid.npy', makeStringNpy(600_000)],
            ['b-valid.npy', makeStringNpy(400_000)]
        ]);

        const document = await parseNumpyArchiveSafely(data);

        expect(document.arrays[1]?.values[0]).toHaveLength(400_000);
    });

    it('keeps archive diagnostics alongside array diagnostics', async () => {
        parserCore.parseNpy.mockReturnValueOnce({
            arrays: [{
                name: 'a-good', dtype: '=u1', byteOrder: 'native', kind: 'unsigned integer',
                shape: [1], fortranOrder: false, elements: 1, byteLength: 1, values: [1],
                previewTruncated: false, warnings: ['Native endian.'],
                diagnostics: [{ code: 'nativeEndian' }]
            }]
        });
        const data = await makeArchive([
            ['a-good.npy', makeNpy(new Uint8Array([1]))],
            ['z-bad.npy', new Uint8Array([1, 2, 3])]
        ]);

        const document = await parseNumpyArchiveSafely(data);

        expect(document.diagnostics?.map((item) => item.code)).toEqual(
            expect.arrayContaining(['nativeEndian', 'npzEntryRead'])
        );
    });

    it('localizes an oversized NPY header through a diagnostic', async () => {
        const bytes = new Uint8Array(12 + 1024 * 1024 + 1);
        bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 2, 0], 0);
        new DataView(bytes.buffer).setUint32(8, 1024 * 1024 + 1, true);

        const document = await parseNumpyFileSafely(bytes, 'header.npy');

        expect(document.diagnostics?.[0]?.code).toBe('npyHeaderSize');
    });

    it('bounds JSZip initialization errors before returning them to the renderer', async () => {
        jest.spyOn(JSZip, 'loadAsync').mockRejectedValueOnce(new Error('x'.repeat(60_000)));
        const document = await parseNumpyArchiveSafely(
            new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])
        );

        expect(document.warnings[0]?.length).toBeLessThanOrEqual(560);
        expect(document.diagnostics?.[0]).toEqual({
            code: 'npzRead',
            args: { reason: `${'x'.repeat(511)}…` }
        });
    });

    it('preserves the NPY format in an invalid standalone model', async () => {
        const document = await parseNumpyFileSafely(new Uint8Array([1, 2, 3, 4]), 'bad.npy');

        expect(document.format).toBe('NumPy NPY');
        expect(document.title).toBe('NumPy array');
        expect(document.arrays).toEqual([]);
    });

    it('keeps payloadShort when the declared string payload size is unsafe', async () => {
        const document = await parseNumpyFileSafely(
            makeStringNpy(1024 * 1024, '', Number.MAX_SAFE_INTEGER, 1024 * 1024),
            'unsafe-size.npy'
        );

        expect(document.diagnostics?.map((item) => item.code)).toEqual(
            expect.arrayContaining(['payloadShort', 'textPreviewLimit'])
        );
    });
});
