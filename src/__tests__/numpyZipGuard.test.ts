import JSZip from 'jszip';
import {
    assertSafeNumpyArchive,
    readNumpyZipDeclaration
} from '../templates/numpy/js/numpyZipGuard';

async function makeZip(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file('a.npy', new Uint8Array([1, 2, 3, 4]));
    zip.file('notes.txt', 'ok');
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('NumPy NPZ ZIP preflight guard', () => {
    it('accepts the empty classic ZIP emitted by numpy.savez()', async () => {
        const bytes = await new JSZip().generateAsync({ type: 'uint8array' });

        expect(bytes).toHaveLength(22);
        expect(readNumpyZipDeclaration(bytes)).toEqual({ entries: 0, expandedBytes: 0 });
        expect(() => assertSafeNumpyArchive(bytes)).not.toThrow();
    });

    it('reads entry count and declared expansion without inflating members', async () => {
        const bytes = await makeZip();

        expect(readNumpyZipDeclaration(bytes)).toEqual({
            entries: 2,
            expandedBytes: 6
        });
        expect(() => assertSafeNumpyArchive(bytes)).not.toThrow();
    });

    it('rejects an oversized declared expansion before worker parsing', async () => {
        const bytes = await makeZip();
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let offset = 0; offset + 46 <= bytes.byteLength; offset += 1) {
            if (view.getUint32(offset, true) !== 0x02014b50) continue;
            view.setUint32(offset + 24, 0x30000000, true);
            break;
        }

        expect(() => assertSafeNumpyArchive(bytes)).toThrow('exceeds 512 MB');
    });

    it('rejects a truncated ZIP instead of handing it to an inflater', () => {
        const truncated = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);

        expect(() => assertSafeNumpyArchive(truncated)).toThrow('truncated');
    });

    it('rejects non-ZIP bytes', () => {
        expect(() => assertSafeNumpyArchive(new Uint8Array([1, 2, 3, 4]))).toThrow(
            'not a valid NPZ ZIP archive'
        );
    });
});
