const EOCD = 0x06054b50;
const CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_DIGITAL_SIGNATURE = 0x05054b50;
const EOCD_SEARCH_SPAN = 22 + 0xffff;

export const NUMPY_NPZ_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const NUMPY_NPZ_MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
export const NUMPY_NPZ_MAX_ENTRIES = 2000;

export interface NumpyZipDeclaration {
    entries: number;
    expandedBytes: number;
}

/**
 * Read the classic ZIP central directory without inflating any member.
 * Unknown, ZIP64, multi-disk, truncated, and inconsistent layouts are
 * rejected because they cannot be bounded safely before JSZip starts.
 */
export function readNumpyZipDeclaration(input: Uint8Array): NumpyZipDeclaration | null {
    if (input.byteLength < 4) return null;
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const firstSignature = view.getUint32(0, true);
    // A valid empty ZIP consists only of its EOCD record. NumPy emits this
    // layout for `numpy.savez()` with no arrays.
    if (firstSignature !== LOCAL_FILE_HEADER && firstSignature !== EOCD) return null;
    if (input.byteLength < 22) throw new Error('The NPZ ZIP directory is truncated.');

    let eocd = -1;
    const searchStart = Math.max(0, input.byteLength - EOCD_SEARCH_SPAN);
    for (let offset = input.byteLength - 22; offset >= searchStart; offset -= 1) {
        if (view.getUint32(offset, true) !== EOCD) continue;
        if (offset + 22 + view.getUint16(offset + 20, true) !== input.byteLength) continue;
        eocd = offset;
        break;
    }
    if (eocd < 0) throw new Error('The NPZ ZIP end-of-directory record is missing.');

    const disk = view.getUint16(eocd + 4, true);
    const centralDisk = view.getUint16(eocd + 6, true);
    const diskEntries = view.getUint16(eocd + 8, true);
    const entries = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    let offset = view.getUint32(eocd + 16, true);
    if (
        disk === 0xffff || centralDisk === 0xffff || diskEntries === 0xffff ||
        entries === 0xffff || centralSize === 0xffffffff || offset === 0xffffffff
    ) {
        throw new Error('ZIP64 NPZ archives exceed the supported safety envelope.');
    }
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries) {
        throw new Error('Multi-disk NPZ archives are not supported.');
    }
    if (entries > NUMPY_NPZ_MAX_ENTRIES) {
        throw new Error(`The NPZ archive exceeds the ${NUMPY_NPZ_MAX_ENTRIES} entry safety limit.`);
    }

    const centralEnd = offset + centralSize;
    if (offset > eocd || centralEnd !== eocd) {
        throw new Error('The NPZ ZIP central directory is inconsistent.');
    }

    let expandedBytes = 0;
    for (let index = 0; index < entries; index += 1) {
        if (
            offset + 46 > centralEnd ||
            view.getUint32(offset, true) !== CENTRAL_DIRECTORY_FILE_HEADER
        ) {
            throw new Error('The NPZ ZIP central directory is malformed.');
        }
        const size = view.getUint32(offset + 24, true);
        if (size === 0xffffffff) {
            throw new Error('ZIP64 NPZ members exceed the supported safety envelope.');
        }
        expandedBytes += size;
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > NUMPY_NPZ_MAX_EXPANDED_BYTES) {
            throw new Error('The NPZ declared uncompressed size exceeds 512 MB.');
        }
        offset += 46
            + view.getUint16(offset + 28, true)
            + view.getUint16(offset + 30, true)
            + view.getUint16(offset + 32, true);
        if (offset > centralEnd) {
            throw new Error('The NPZ ZIP central directory is malformed.');
        }
    }

    if (
        offset < centralEnd &&
        offset + 6 <= centralEnd &&
        view.getUint32(offset, true) === CENTRAL_DIRECTORY_DIGITAL_SIGNATURE
    ) {
        offset += 6 + view.getUint16(offset + 4, true);
    }
    if (offset !== centralEnd) throw new Error('The NPZ ZIP central directory is malformed.');

    return { entries, expandedBytes };
}

export function assertSafeNumpyArchive(input: Uint8Array): void {
    if (input.byteLength > NUMPY_NPZ_MAX_ARCHIVE_BYTES) {
        throw new Error('The NPZ archive exceeds the 512 MB compressed-size safety limit.');
    }
    const declaration = readNumpyZipDeclaration(input);
    if (!declaration) throw new Error('The file is not a valid NPZ ZIP archive.');
}
