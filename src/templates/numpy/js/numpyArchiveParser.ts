import JSZip from 'jszip';
import {
    formatFileSize,
    parseNpy,
    type NumpyArray,
    type NumpyDiagnostic,
    type NumpyDocument
} from 'omni-viewer-core/parsers/numpy';

const DEFAULT_MAX_ARRAYS = 1000;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_PREVIEW_ELEMENTS = 100_000;
const MAX_RENDER_RANK = 64;
const MAX_NPY_HEADER_BYTES = 1024 * 1024;
const MAX_STRING_ITEM_BYTES = 1024 * 1024;
const MAX_STRING_VALUE_CHARS = 4096;
const MAX_STRING_PREVIEW_CHARS = 1_000_000;
const MAX_DISPLAY_NAME_CHARS = 256;
const MAX_DTYPE_CHARS = 256;
const MAX_KIND_CHARS = 128;
const MAX_WARNING_CHARS = 512;
const MAX_WARNINGS_PER_ARRAY = 8;

export interface NumpyArchiveSafetyLimits {
    maxArrays: number;
    maxEntryBytes: number;
    maxTotalBytes: number;
    previewElements: number;
}

const DEFAULT_LIMITS: NumpyArchiveSafetyLimits = {
    maxArrays: DEFAULT_MAX_ARRAYS,
    maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES,
    maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
    previewElements: DEFAULT_PREVIEW_ELEMENTS
};

interface ZipByteStream {
    on(event: 'data', callback: (chunk: Uint8Array) => void): ZipByteStream;
    on(event: 'error', callback: (error: Error) => void): ZipByteStream;
    on(event: 'end', callback: () => void): ZipByteStream;
    pause(): ZipByteStream;
    resume(): ZipByteStream;
}

type StreamableZipObject = JSZip.JSZipObject & {
    internalStream(type: 'uint8array'): ZipByteStream;
    _data?: { crc32?: number };
};

class ZipEntryLimitError extends Error {}
class ZipTotalLimitError extends Error {}
class ZipCrcError extends Error {}

/**
 * Parse selected NPY members from an NPZ without ever accumulating an
 * unbounded inflated member. This runs inside a terminable Worker; the core
 * remains responsible for each NPY payload's dtype/header decoding.
 */
export async function parseNumpyArchiveSafely(
    data: Uint8Array,
    limits: NumpyArchiveSafetyLimits = DEFAULT_LIMITS
): Promise<NumpyDocument> {
    try {
        // checkCRC32:true asks JSZip to inflate every member up front. Selected
        // members are instead streamed through byte and CRC limits below.
        const zip = await JSZip.loadAsync(data, { checkCRC32: false, createFolders: false });
        const entries = Object.values(zip.files)
            .filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith('.npy'))
            .sort((left, right) => left.name.localeCompare(right.name));
        const archiveWarnings: string[] = [];
        const archiveDiagnostics: NumpyDiagnostic[] = [];
        const warnArchive = (
            code: string,
            message: string,
            args?: Record<string, string | number>
        ): void => {
            archiveWarnings.push(message);
            archiveDiagnostics.push({ code, ...(args ? { args } : {}) });
        };
        if (entries.length > limits.maxArrays) {
            warnArchive(
                'npzArrayCount',
                `Only the first ${limits.maxArrays} arrays are shown.`,
                { limit: limits.maxArrays }
            );
        }

        const arrays: NumpyArray[] = [];
        const expansionBudget = { remaining: limits.maxTotalBytes };
        const textBudget = { remaining: MAX_STRING_PREVIEW_CHARS };
        let previewRemaining = limits.previewElements;
        for (const entry of entries.slice(0, limits.maxArrays)) {
            const displayEntryName = boundedDisplayName(entry.name);
            let payload: Uint8Array;
            try {
                payload = await readZipEntryBounded(
                    entry,
                    limits.maxEntryBytes,
                    expansionBudget
                );
            } catch (error) {
                if (error instanceof ZipTotalLimitError) {
                    const limit = formatFileSize(limits.maxTotalBytes);
                    warnArchive(
                        'npzTotalSize',
                        `Stopped expanding arrays at the ${limit} total safety limit.`,
                        { limit }
                    );
                    break;
                }
                if (error instanceof ZipEntryLimitError) {
                    const limit = formatFileSize(limits.maxEntryBytes);
                    warnArchive(
                        'npzArraySize',
                        `${displayEntryName}: the uncompressed array exceeds the ${limit} safety limit.`,
                        { name: displayEntryName, limit }
                    );
                    continue;
                }
                if (error instanceof ZipCrcError) {
                    warnArchive(
                        'npzCrc',
                        `${displayEntryName}: CRC validation failed; the array was skipped.`,
                        { name: displayEntryName }
                    );
                    continue;
                }
                const reason = error instanceof Error ? error.message : String(error);
                const boundedReason = boundedMetadataText(reason, MAX_WARNING_CHARS);
                warnArchive(
                    'npzEntryRead',
                    `${displayEntryName}: the array member could not be decompressed and was skipped: ${boundedReason}`,
                    { name: displayEntryName, reason: boundedReason }
                );
                continue;
            }

            const name = displayEntryName.replace(/\.npy$/i, '');
            const parsedArray = parseNpyArrayBounded(payload, name, textBudget);
            const array = parsedArray ? sanitizeArrayForRender(parsedArray) : undefined;
            if (!array) {
                const reason = 'The NPY member is invalid.';
                warnArchive(
                    'npzEntryRead',
                    `${displayEntryName}: the NPY member is invalid and was skipped.`,
                    { name: displayEntryName, reason }
                );
                continue;
            }

            if (array.values.length > previewRemaining) {
                array.values = array.values.slice(0, previewRemaining);
                array.previewTruncated = true;
                if (!array.warnings.some((warning) => warning.includes('document value preview'))) {
                    array.warnings.push(
                        `The document value preview is limited to ${limits.previewElements.toLocaleString('en-US')} elements.`
                    );
                    array.diagnostics = [
                        ...(array.diagnostics ?? []),
                        { code: 'previewLimit', args: { limit: limits.previewElements } }
                    ];
                }
            }
            previewRemaining -= array.values.length;
            arrays.push(array);
        }

        if (!entries.length) {
            warnArchive(
                'npzNoArrays',
                'The NPZ archive does not contain any .npy arrays.'
            );
        }
        const document = documentFromArrays('NumPy NPZ', arrays, data.byteLength);
        document.warnings.unshift(...archiveWarnings);
        document.diagnostics?.unshift(...archiveDiagnostics.map(sanitizeDiagnostic));
        return document;
    } catch (error) {
        const reason = boundedMetadataText(
            error instanceof Error ? error.message : String(error),
            MAX_WARNING_CHARS
        );
        return invalidDocument(
            'NumPy NPZ',
            data.byteLength,
            `The NPZ archive could not be read: ${reason}`,
            { code: 'npzRead', args: { reason } }
        );
    }
}

/** Parse a standalone NPY through core, then bound renderer-facing metadata. */
export async function parseNumpyFileSafely(
    data: Uint8Array,
    fileName: string
): Promise<NumpyDocument> {
    const part = fileName.split(/[\\/]/).pop() ?? fileName;
    const name = boundedDisplayName(part).replace(/\.npy$/i, '') || 'array';
    const array = parseNpyArrayBounded(
        data,
        name,
        { remaining: MAX_STRING_PREVIEW_CHARS }
    );
    if (!array) {
        return invalidDocument(
            'NumPy NPY',
            data.byteLength,
            'The NPY array could not be parsed.',
            { code: 'npyMagic' }
        );
    }
    return documentFromArrays(
        'NumPy NPY',
        [sanitizeArrayForRender(array)],
        data.byteLength
    );
}

/**
 * The published core limits scalar count, but not the characters held by one
 * S/U scalar. Avoid calling it when the worst-case preview text would exceed
 * the renderer/model budget; metadata remains available without allocation.
 */
function parseNpyArrayBounded(
    data: Uint8Array,
    name: string,
    textBudget: { remaining: number }
): NumpyArray | undefined {
    const metadataOnly = inspectOversizedStringPreview(data, name, textBudget);
    if (metadataOnly) return metadataOnly;
    const array = parseNpy(data, name).arrays[0];
    if (array && (array.kind === 'byte string' || array.kind === 'Unicode string')) {
        const used = array.values.reduce(
            (total, value) => total + (typeof value === 'string' ? value.length : 0),
            0
        );
        textBudget.remaining = Math.max(0, textBudget.remaining - used);
    }
    return array;
}

function inspectOversizedStringPreview(
    data: Uint8Array,
    name: string,
    textBudget: { remaining: number }
): NumpyArray | undefined {
    if (data.byteLength < 10) return undefined;
    if (
        data[0] !== 0x93 || data[1] !== 0x4e || data[2] !== 0x55 ||
        data[3] !== 0x4d || data[4] !== 0x50 || data[5] !== 0x59
    ) {
        return undefined;
    }
    const major = data[6];
    const headerLengthBytes = major === 1 ? 2 : major === 2 || major === 3 ? 4 : 0;
    if (!headerLengthBytes || data.byteLength < 8 + headerLengthBytes) return undefined;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const headerLength = headerLengthBytes === 2
        ? view.getUint16(8, true)
        : view.getUint32(8, true);
    if (headerLength > MAX_NPY_HEADER_BYTES) {
        return emptyMetadataArray(name, 'unknown', [], false, 0, 0,
            `The NPY header exceeds the ${formatFileSize(MAX_NPY_HEADER_BYTES)} safety limit.`,
            {
                code: 'npyHeaderSize',
                args: { limit: formatFileSize(MAX_NPY_HEADER_BYTES) }
            });
    }
    const headerStart = 8 + headerLengthBytes;
    const dataOffset = headerStart + headerLength;
    if (headerLength === 0 || dataOffset > data.byteLength) return undefined;
    let header: string;
    try {
        const headerBytes = data.subarray(headerStart, dataOffset);
        header = major === 3
            ? new TextDecoder('utf-8', { fatal: true }).decode(headerBytes)
            : decodeLatin1(headerBytes);
    } catch {
        return undefined;
    }
    const descr = header.match(/["']descr["']\s*:\s*(["'])(.*?)\1/s)?.[2];
    const fortranText = header.match(/["']fortran_order["']\s*:\s*(True|False)/)?.[1];
    const shapeText = header.match(/["']shape["']\s*:\s*\(([^)]*)\)/s)?.[1];
    const dtype = descr?.match(/^([<>=|])?([SU])(\d+)(?:\[[^\]]+\])?$/);
    if (!descr || !fortranText || shapeText === undefined || !dtype) return undefined;
    const shape = parseSimpleShape(shapeText);
    if (!shape) return undefined;
    const elements = safeElementCount(shape);
    const declaredUnits = Number(dtype[3]);
    if (elements === undefined || !Number.isSafeInteger(declaredUnits)) return undefined;
    const itemBytes = dtype[2] === 'U' ? declaredUnits * 4 : declaredUnits;
    if (!Number.isSafeInteger(itemBytes)) return undefined;
    const payloadBytes = data.byteLength - dataOffset;
    const readableElements = itemBytes === 0
        ? elements
        : Math.min(elements, Math.floor(payloadBytes / itemBytes));
    const previewElements = Math.min(readableElements, DEFAULT_PREVIEW_ELEMENTS);
    const worstCaseChars = previewElements * declaredUnits * 2;
    if (
        itemBytes <= MAX_STRING_ITEM_BYTES &&
        Number.isSafeInteger(worstCaseChars) &&
        worstCaseChars <= textBudget.remaining
    ) {
        return undefined;
    }
    // Validate the complete header with core's strict Python-dict grammar.
    // Supplying only the header prevents S/U value allocation while retaining
    // duplicate-field, version, tuple, and trailing-syntax diagnostics.
    const validated = parseNpy(data.subarray(0, dataOffset), name).arrays[0];
    if (!validated) return undefined;
    const headerIsValid = validated.dtype === descr
        && validated.fortranOrder === (fortranText === 'True')
        && validated.shape.length === shape.length
        && validated.shape.every((dimension, index) => dimension === shape[index]);
    if (!headerIsValid) return validated;
    const diagnostics = (validated.diagnostics ?? [])
        .filter((diagnostic) => diagnostic.code !== 'payloadShort');
    const warnings = (validated.diagnostics?.length
        ? validated.warnings.filter((_, index) => validated.diagnostics?.[index]?.code !== 'payloadShort')
        : validated.warnings.filter((warning) => !warning.includes('payload is shorter'))
    );
    const expectedBytes = elements * itemBytes;
    if (!Number.isSafeInteger(expectedBytes) || payloadBytes < expectedBytes) {
        warnings.push('The array payload is shorter than its dtype and shape require.');
        diagnostics.push({ code: 'payloadShort' });
    } else if (Number.isSafeInteger(expectedBytes) && payloadBytes > expectedBytes) {
        warnings.push('The array payload contains trailing bytes.');
        diagnostics.push({ code: 'payloadTrailing' });
    }
    return {
        ...validated,
        byteLength: payloadBytes,
        values: [],
        previewTruncated: readableElements > 0,
        warnings: [
            ...warnings,
            `String values are not previewed because the document text would exceed the ${MAX_STRING_PREVIEW_CHARS.toLocaleString('en-US')}-character safety limit.`
        ],
        diagnostics: [
            ...diagnostics,
            {
                code: 'textPreviewLimit',
                args: {
                    perValue: MAX_STRING_VALUE_CHARS,
                    total: MAX_STRING_PREVIEW_CHARS
                }
            }
        ]
    };
}

function boundedDisplayName(name: string): string {
    if (name.length <= MAX_DISPLAY_NAME_CHARS) return name;
    const tailLength = 32;
    return `${name.slice(0, MAX_DISPLAY_NAME_CHARS - tailLength - 1)}…${name.slice(-tailLength)}`;
}

function boundedMetadataText(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function decodeLatin1(bytes: Uint8Array): string {
    let output = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
        output += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return output;
}

function emptyMetadataArray(
    name: string,
    dtype: string,
    shape: number[],
    fortranOrder: boolean,
    elements: number,
    byteLength: number,
    warning: string,
    diagnostic?: NumpyDiagnostic
): NumpyArray {
    return {
        name,
        dtype,
        byteOrder: 'not-applicable',
        kind: 'unknown',
        shape,
        fortranOrder,
        elements,
        byteLength,
        values: [],
        previewTruncated: false,
        warnings: [warning],
        ...(diagnostic ? { diagnostics: [diagnostic] } : {})
    };
}

function parseSimpleShape(text: string): number[] | undefined {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
    const shape = parts.map((part) => Number(part.replace(/[lL]$/, '')));
    return shape.every((value) => Number.isSafeInteger(value) && value >= 0)
        ? shape
        : undefined;
}

function safeElementCount(shape: readonly number[]): number | undefined {
    let result = 1;
    for (const dimension of shape) {
        if (dimension !== 0 && result > Number.MAX_SAFE_INTEGER / dimension) return undefined;
        result *= dimension;
    }
    return result;
}

function sanitizeArrayForRender(array: NumpyArray): NumpyArray {
    const rankExceeded = array.shape.length > MAX_RENDER_RANK;
    const warnings = [...array.warnings];
    if (rankExceeded) {
        warnings.push(
            `The array rank exceeds the ${MAX_RENDER_RANK}-axis rendering safety limit; values are not previewed.`
        );
        array.diagnostics = [
            ...(array.diagnostics ?? []),
            { code: 'npyRank', args: { limit: MAX_RENDER_RANK } }
        ];
    }
    return {
        ...array,
        name: boundedDisplayName(array.name),
        dtype: boundedMetadataText(array.dtype, MAX_DTYPE_CHARS),
        kind: boundedMetadataText(array.kind, MAX_KIND_CHARS),
        // The published core renderer creates one slice control per leading
        // axis. Preserve a bounded shape prefix for metadata, but suppress the
        // value grid so hostile ranks cannot generate unbounded DOM.
        shape: rankExceeded ? array.shape.slice(0, MAX_RENDER_RANK) : array.shape,
        values: rankExceeded ? [] : array.values,
        previewTruncated: rankExceeded || array.previewTruncated,
        warnings: warnings
            .slice(0, MAX_WARNINGS_PER_ARRAY)
            .map((warning) => boundedMetadataText(warning, MAX_WARNING_CHARS)),
        diagnostics: array.diagnostics
            ?.slice(0, MAX_WARNINGS_PER_ARRAY)
            .map(sanitizeDiagnostic)
    };
}

function sanitizeDiagnostic(diagnostic: NumpyDiagnostic): NumpyDiagnostic {
    const args = diagnostic.args
        ? Object.fromEntries(Object.entries(diagnostic.args).map(([key, value]) => [
            boundedMetadataText(key, MAX_KIND_CHARS),
            typeof value === 'string'
                ? boundedMetadataText(value, MAX_WARNING_CHARS)
                : value
        ]))
        : undefined;
    return {
        code: boundedMetadataText(diagnostic.code, MAX_KIND_CHARS),
        ...(args ? { args } : {})
    };
}

function readZipEntryBounded(
    entry: JSZip.JSZipObject,
    entryLimit: number,
    totalBudget: { remaining: number }
): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
        const streamEntry = entry as StreamableZipObject;
        const stream = streamEntry.internalStream('uint8array');
        const expectedCrc = streamEntry._data?.crc32;
        const chunks: Uint8Array[] = [];
        let total = 0;
        let crc = 0xffffffff;
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            callback();
        };
        stream.on('data', (chunk) => {
            if (settled) return;
            total += chunk.byteLength;
            totalBudget.remaining -= chunk.byteLength;
            if (totalBudget.remaining < 0) {
                stream.pause();
                finish(() => reject(new ZipTotalLimitError()));
                return;
            }
            if (total > entryLimit) {
                stream.pause();
                finish(() => reject(new ZipEntryLimitError()));
                return;
            }
            crc = updateCrc32(crc, chunk);
            chunks.push(chunk);
        });
        stream.on('error', (error) => finish(() => reject(error)));
        stream.on('end', () => finish(() => {
            const actualCrc = (crc ^ 0xffffffff) >>> 0;
            if (expectedCrc === undefined || actualCrc !== (expectedCrc >>> 0)) {
                reject(new ZipCrcError());
                return;
            }
            const output = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                output.set(chunk, offset);
                offset += chunk.byteLength;
            }
            resolve(output);
        }));
        stream.resume();
    });
}

function documentFromArrays(
    format: NumpyDocument['format'],
    arrays: NumpyArray[],
    bytes: number
): NumpyDocument {
    const totalElements = arrays.reduce((sum, array) => sum + array.elements, 0);
    const dtypes = [...new Set(arrays.map((array) => array.dtype))];
    const diagnostics = arrays.flatMap((array) => (array.diagnostics ?? []).map((diagnostic) => ({
        ...diagnostic,
        args: {
            ...(diagnostic.args ?? {}),
            ...(arrays.length > 1 ? { name: array.name } : {})
        }
    })));
    return {
        format,
        title: format === 'NumPy NPZ' ? 'NumPy array archive' : 'NumPy array',
        fileSize: formatFileSize(bytes),
        arrays,
        summary: [
            { label: 'Arrays', value: arrays.length },
            { label: 'Elements', value: formatCount(totalElements) },
            { label: 'Data types', value: dtypes.length ? dtypes.join(', ') : '—' }
        ],
        tables: [{
            title: `Arrays (${arrays.length})`,
            headers: ['Name', 'Dtype', 'Shape', 'Order', 'Elements', 'Data size'],
            rows: arrays.map((array) => [
                array.name,
                array.dtype,
                array.shape.length ? array.shape.join(' × ') : 'scalar',
                array.fortranOrder ? 'Fortran' : 'C',
                array.elements,
                formatFileSize(array.byteLength)
            ])
        }],
        warnings: arrays.flatMap((array) => array.warnings.map(
            (warning) => arrays.length > 1 ? `${array.name}: ${warning}` : warning
        )),
        diagnostics
    };
}

function invalidDocument(
    format: NumpyDocument['format'],
    bytes: number,
    warning: string,
    diagnostic: NumpyDiagnostic
): NumpyDocument {
    return {
        format,
        title: format === 'NumPy NPZ' ? 'NumPy array archive' : 'NumPy array',
        fileSize: formatFileSize(bytes),
        arrays: [],
        summary: [{ label: 'Status', value: 'invalid' }],
        tables: [],
        warnings: [warning],
        diagnostics: [sanitizeDiagnostic(diagnostic)]
    };
}

function formatCount(count: number): string {
    if (count < 1000) return String(count);
    for (const [threshold, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
        if (count >= threshold) {
            const value = count / threshold;
            return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2) + suffix;
        }
    }
    return String(count);
}

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let value = 0; value < table.length; value += 1) {
        let crc = value;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
        }
        table[value] = crc >>> 0;
    }
    return table;
})();

function updateCrc32(crc: number, bytes: Uint8Array): number {
    let value = crc;
    for (const byte of bytes) {
        value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
    }
    return value >>> 0;
}
