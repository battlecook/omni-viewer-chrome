// Browser port of vscode-omni-viewer/src/utils/fileUtils/archivePreviewDecoder.ts.
// All Buffer operations replaced with Uint8Array + DataView equivalents.

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const NO_INDEX = 0xFFFFFFFF;

export interface DecodedArchivePreview {
    content: string;
    description: string;
}

/**
 * Kinds the archive viewer can render inline once an entry is extracted.
 * Owned by issue #57; the viewer maps each kind to a different DOM
 * presentation:
 *
 *   - `text`      — small UTF-8 text payloads (≤256 KB) rendered into a
 *                   monospace `<pre>`.
 *   - `image`     — common raster + SVG formats; rendered via `<img>` with a
 *                   blob ObjectURL.
 *   - `audio`     — common audio formats; rendered via `<audio controls>` +
 *                   ObjectURL.
 *   - `video`     — common video formats; rendered via `<video controls>` +
 *                   ObjectURL.
 *   - `binary`    — fallback hex dump of the leading bytes (first 4 KB).
 *   - `too-large` — text-looking entry that exceeds the inline cap; the
 *                   viewer surfaces a download affordance instead.
 */
export type ArchivePreviewKind = 'text' | 'image' | 'audio' | 'video' | 'binary' | 'too-large';

export interface ArchivePreviewClassification {
    kind: ArchivePreviewKind;
    /** UTF-8 decoded text (only set when `kind === 'text'`). */
    text?: string;
    /** MIME type used when constructing a Blob (for image/audio/video kinds). */
    mime?: string;
    /** Hex+ASCII dump (only set when `kind === 'binary'`). */
    hex?: string;
    /** True if the text payload was truncated to fit the inline cap. */
    textTruncated?: boolean;
    /** Bytes considered for the preview (always equal to `bytes.length`). */
    byteLength: number;
}

/**
 * Soft cap on bytes rendered as inline text. Text-looking payloads larger
 * than this fall through to the `too-large` kind so the viewer can offer a
 * download button instead of locking up the DOM.
 */
export const ARCHIVE_TEXT_PREVIEW_LIMIT = 256 * 1024;

/** Soft cap on bytes rendered as a hex dump for the `binary` fallback. */
export const ARCHIVE_HEX_PREVIEW_LIMIT = 4 * 1024;

interface BinaryXmlAttribute {
    namespaceUri: string | null;
    name: string;
    value: string;
}

interface BinaryXmlElement {
    namespaceUri: string | null;
    name: string;
    attributes: BinaryXmlAttribute[];
}

interface StringPool {
    strings: string[];
}

interface ChunkHeader {
    type: number;
    headerSize: number;
    size: number;
}

// Lazy decoders — see fileUtils.ts for the rationale (jest-environment-jsdom 29
// does not expose `TextDecoder` as a global at module-load time).
let _utf8Decoder: TextDecoder | null = null;
let _utf16Decoder: TextDecoder | null = null;

function utf8Decoder(): TextDecoder {
    if (!_utf8Decoder) {
        _utf8Decoder = new TextDecoder('utf-8');
    }
    return _utf8Decoder;
}

function utf16Decoder(): TextDecoder {
    if (!_utf16Decoder) {
        _utf16Decoder = new TextDecoder('utf-16le');
    }
    return _utf16Decoder;
}

export function tryDecodeArchiveEntryPreview(entryPath: string, buffer: Uint8Array): DecodedArchivePreview | null {
    const decodedBinaryXml = decodeAndroidBinaryXml(entryPath, buffer);
    if (decodedBinaryXml) {
        return decodedBinaryXml;
    }
    return null;
}

function decodeAndroidBinaryXml(entryPath: string, buffer: Uint8Array): DecodedArchivePreview | null {
    if (!looksLikeAndroidBinaryXml(entryPath, buffer)) {
        return null;
    }

    const stringPool = parseAndroidStringPool(buffer);
    if (!stringPool) {
        return null;
    }

    const namespaceStack = new Map<string, string[]>();
    const prefixByUri = new Map<string, string>();
    const pendingNamespaceDecls = new Map<string, string>();
    const elementStack: BinaryXmlElement[] = [];
    const lines: string[] = ['<?xml version="1.0" encoding="utf-8"?>'];
    let offset = readChunkHeader(buffer, 0)?.headerSize ?? 8;

    while (offset + 8 <= buffer.length) {
        const chunk = readChunkHeader(buffer, offset);
        if (!chunk || chunk.size <= 0 || offset + chunk.size > buffer.length) {
            return null;
        }

        switch (chunk.type) {
        case RES_XML_START_NAMESPACE_TYPE:
            parseNamespaceChunk(buffer, offset, stringPool, namespaceStack, prefixByUri, pendingNamespaceDecls, true);
            break;
        case RES_XML_END_NAMESPACE_TYPE:
            parseNamespaceChunk(buffer, offset, stringPool, namespaceStack, prefixByUri, pendingNamespaceDecls, false);
            break;
        case RES_XML_START_ELEMENT_TYPE: {
            const element = parseStartElementChunk(buffer, offset, chunk, stringPool);
            if (!element) {
                return null;
            }

            const indent = '  '.repeat(elementStack.length);
            const qualifiedName = qualifyName(element.namespaceUri, element.name, prefixByUri);
            const attrText = element.attributes
                .map((attribute) => `${qualifyName(attribute.namespaceUri, attribute.name, prefixByUri)}="${escapeXml(attribute.value)}"`)
                .join(' ');

            const namespaceDecls = Array.from(pendingNamespaceDecls.entries())
                .map(([uri, prefix]) => {
                    const escapedUri = escapeXml(uri);
                    return prefix.length > 0
                        ? `xmlns:${prefix}="${escapedUri}"`
                        : `xmlns="${escapedUri}"`;
                })
                .join(' ');
            pendingNamespaceDecls.clear();

            const parts = [qualifiedName];
            if (namespaceDecls) {
                parts.push(namespaceDecls);
            }
            if (attrText) {
                parts.push(attrText);
            }
            lines.push(`${indent}<${parts.join(' ')}>`);
            elementStack.push(element);
            break;
        }
        case RES_XML_END_ELEMENT_TYPE: {
            const element = parseEndElementChunk(buffer, offset, stringPool);
            if (!element) {
                return null;
            }

            const current = elementStack.pop();
            const depth = Math.max(elementStack.length, 0);
            const indent = '  '.repeat(depth);
            const qualifiedName = qualifyName(element.namespaceUri, element.name, prefixByUri);
            if (current && (current.name !== element.name || current.namespaceUri !== element.namespaceUri)) {
                return null;
            }
            lines.push(`${indent}</${qualifiedName}>`);
            break;
        }
        default:
            break;
        }

        offset += chunk.size;
    }

    if (lines.length === 1) {
        return null;
    }

    return {
        content: lines.join('\n'),
        description: `Decoded from Android binary XML (${getExtension(entryPath) || 'entry'}).`
    };
}

function looksLikeAndroidBinaryXml(entryPath: string, buffer: Uint8Array): boolean {
    if (!entryPath.toLowerCase().endsWith('.xml')) {
        return false;
    }

    const xmlChunk = readChunkHeader(buffer, 0);
    if (!xmlChunk) {
        return false;
    }

    if (xmlChunk.type !== RES_XML_TYPE || xmlChunk.headerSize < 8 || xmlChunk.size > buffer.length) {
        return false;
    }

    const nextChunk = readChunkHeader(buffer, xmlChunk.headerSize);
    return nextChunk?.type === RES_STRING_POOL_TYPE;
}

function parseAndroidStringPool(buffer: Uint8Array): StringPool | null {
    const header = readChunkHeader(buffer, 8);
    if (!header || header.type !== RES_STRING_POOL_TYPE || header.headerSize < 28 || header.size > buffer.length) {
        return null;
    }

    const chunkStart = 8;
    const stringCount = readUInt32LE(buffer, chunkStart + 8);
    const flags = readUInt32LE(buffer, chunkStart + 16);
    const stringsStart = readUInt32LE(buffer, chunkStart + 20);
    const isUtf8 = (flags & 0x00000100) !== 0;
    const offsetsStart = chunkStart + header.headerSize;
    const stringsBase = chunkStart + stringsStart;
    const strings: string[] = [];

    for (let index = 0; index < stringCount; index += 1) {
        const offsetPosition = offsetsStart + (index * 4);
        if (offsetPosition + 4 > chunkStart + header.size) {
            return null;
        }

        const stringOffset = readUInt32LE(buffer, offsetPosition);
        const absoluteOffset = stringsBase + stringOffset;
        if (absoluteOffset >= chunkStart + header.size) {
            return null;
        }

        strings.push(isUtf8 ? readUtf8String(buffer, absoluteOffset) : readUtf16String(buffer, absoluteOffset));
    }

    return { strings };
}

function readUtf8String(buffer: Uint8Array, offset: number): string {
    const [, charLengthBytes] = readLength8(buffer, offset);
    const [byteLength, byteLengthBytes] = readLength8(buffer, offset + charLengthBytes);
    const start = offset + charLengthBytes + byteLengthBytes;
    return utf8Decoder().decode(buffer.subarray(start, start + byteLength));
}

function readUtf16String(buffer: Uint8Array, offset: number): string {
    const [charLength, lengthBytes] = readLength16(buffer, offset);
    const start = offset + lengthBytes;
    const byteLength = charLength * 2;
    return utf16Decoder().decode(buffer.subarray(start, start + byteLength));
}

function readLength8(buffer: Uint8Array, offset: number): [number, number] {
    const first = buffer[offset];
    if ((first & 0x80) === 0) {
        return [first, 1];
    }
    return [((first & 0x7F) << 8) | buffer[offset + 1], 2];
}

function readLength16(buffer: Uint8Array, offset: number): [number, number] {
    const first = readUInt16LE(buffer, offset);
    if ((first & 0x8000) === 0) {
        return [first, 2];
    }
    const second = readUInt16LE(buffer, offset + 2);
    return [((first & 0x7FFF) << 16) | second, 4];
}

function parseNamespaceChunk(
    buffer: Uint8Array,
    chunkOffset: number,
    stringPool: StringPool,
    namespaceStack: Map<string, string[]>,
    prefixByUri: Map<string, string>,
    pendingNamespaceDecls: Map<string, string>,
    isStart: boolean
): void {
    const prefixIndex = readUInt32LE(buffer, chunkOffset + 16);
    const uriIndex = readUInt32LE(buffer, chunkOffset + 20);
    const prefix = getStringAt(stringPool, prefixIndex) ?? '';
    const uri = getStringAt(stringPool, uriIndex);
    if (!uri) {
        return;
    }

    if (isStart) {
        const prefixes = namespaceStack.get(uri) ?? [];
        prefixes.push(prefix);
        namespaceStack.set(uri, prefixes);
        prefixByUri.set(uri, prefix);
        pendingNamespaceDecls.set(uri, prefix);
        return;
    }

    const prefixes = namespaceStack.get(uri);
    if (!prefixes || prefixes.length === 0) {
        prefixByUri.delete(uri);
        pendingNamespaceDecls.delete(uri);
        return;
    }

    prefixes.pop();
    if (prefixes.length === 0) {
        namespaceStack.delete(uri);
        prefixByUri.delete(uri);
    } else {
        prefixByUri.set(uri, prefixes[prefixes.length - 1]);
    }
}

function parseStartElementChunk(
    buffer: Uint8Array,
    chunkOffset: number,
    header: ChunkHeader,
    stringPool: StringPool
): BinaryXmlElement | null {
    if (header.headerSize < 16) {
        return null;
    }

    const namespaceUri = getStringAt(stringPool, readUInt32LE(buffer, chunkOffset + 16));
    const name = getStringAt(stringPool, readUInt32LE(buffer, chunkOffset + 20));
    if (!name) {
        return null;
    }

    const attributeStart = readUInt16LE(buffer, chunkOffset + 24);
    const attributeSize = readUInt16LE(buffer, chunkOffset + 26);
    const attributeCount = readUInt16LE(buffer, chunkOffset + 28);
    if (attributeSize < 20) {
        return null;
    }

    const attributes: BinaryXmlAttribute[] = [];
    let attributeOffset = chunkOffset + 16 + attributeStart;

    for (let index = 0; index < attributeCount; index += 1) {
        if (attributeOffset + attributeSize > chunkOffset + header.size) {
            return null;
        }

        const attributeNamespaceUri = getStringAt(stringPool, readUInt32LE(buffer, attributeOffset));
        const attributeName = getStringAt(stringPool, readUInt32LE(buffer, attributeOffset + 4));
        if (!attributeName) {
            return null;
        }

        const rawValueIndex = readUInt32LE(buffer, attributeOffset + 8);
        const dataType = buffer[attributeOffset + 15];
        const data = readUInt32LE(buffer, attributeOffset + 16);
        const rawValue = getStringAt(stringPool, rawValueIndex);
        attributes.push({
            namespaceUri: attributeNamespaceUri,
            name: attributeName,
            value: formatTypedValue(dataType, data, rawValue, stringPool)
        });

        attributeOffset += attributeSize;
    }

    return {
        namespaceUri,
        name,
        attributes
    };
}

function parseEndElementChunk(buffer: Uint8Array, chunkOffset: number, stringPool: StringPool): BinaryXmlElement | null {
    const namespaceUri = getStringAt(stringPool, readUInt32LE(buffer, chunkOffset + 16));
    const name = getStringAt(stringPool, readUInt32LE(buffer, chunkOffset + 20));
    if (!name) {
        return null;
    }

    return {
        namespaceUri,
        name,
        attributes: []
    };
}

function formatTypedValue(dataType: number, data: number, rawValue: string | null, stringPool: StringPool): string {
    if (rawValue) {
        return rawValue;
    }

    switch (dataType) {
    case 0x00:
        return '';
    case 0x01:
        return `@0x${data.toString(16).padStart(8, '0')}`;
    case 0x02:
        return `?0x${data.toString(16).padStart(8, '0')}`;
    case 0x03:
        return getStringAt(stringPool, data) ?? '';
    case 0x04:
        return String(uint32ToFloat(data));
    case 0x05:
        return formatComplexUnit(data, ['px', 'dp', 'sp', 'pt', 'in', 'mm']);
    case 0x06:
        return formatComplexUnit(data, ['%', '%p']);
    case 0x10:
        return String(data | 0);
    case 0x11:
        return `0x${data.toString(16)}`;
    case 0x12:
        return data !== 0 ? 'true' : 'false';
    case 0x1C:
    case 0x1D:
    case 0x1E:
    case 0x1F:
        return `#${data.toString(16).padStart(8, '0')}`;
    default:
        return `0x${data.toString(16)}`;
    }
}

function uint32ToFloat(data: number): number {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setUint32(0, data >>> 0, true);
    return new DataView(buffer).getFloat32(0, true);
}

function formatComplexUnit(data: number, units: string[]): string {
    const mantissa = (data & 0xFFFFFF00) >> 8;
    const radix = (data >> 4) & 0x03;
    const unit = data & 0x0F;
    const multipliers = [1 / (1 << 23), 1 / (1 << 15), 1 / (1 << 7), 1];
    const value = mantissa * (multipliers[radix] ?? 1);
    return `${value}${units[unit] ?? ''}`;
}

function qualifyName(namespaceUri: string | null, name: string, prefixByUri: Map<string, string>): string {
    if (!namespaceUri) {
        return name;
    }
    const prefix = prefixByUri.get(namespaceUri);
    return prefix ? `${prefix}:${name}` : name;
}

function getStringAt(stringPool: StringPool, index: number): string | null {
    if (index === NO_INDEX) {
        return null;
    }
    return stringPool.strings[index] ?? null;
}

function readChunkHeader(buffer: Uint8Array, offset: number): ChunkHeader | null {
    if (offset + 8 > buffer.length) {
        return null;
    }
    return {
        type: readUInt16LE(buffer, offset),
        headerSize: readUInt16LE(buffer, offset + 2),
        size: readUInt32LE(buffer, offset + 4)
    };
}

function readUInt16LE(buffer: Uint8Array, offset: number): number {
    return buffer[offset] | (buffer[offset + 1] << 8);
}

function readUInt32LE(buffer: Uint8Array, offset: number): number {
    return (
        (buffer[offset] |
            (buffer[offset + 1] << 8) |
            (buffer[offset + 2] << 16) |
            (buffer[offset + 3] << 24)) >>> 0
    );
}

function getExtension(entryPath: string): string {
    const lower = entryPath.toLowerCase();
    const dot = lower.lastIndexOf('.');
    return dot >= 0 ? lower.slice(dot) : '';
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Preview-kind classification (issue #57)
// ---------------------------------------------------------------------------

/**
 * Extension → media MIME type map used for image/audio/video classification.
 * Limited to the common formats the in-archive preview can actually render
 * via `<img>` / `<audio>` / `<video>`. Unknown types fall through to the
 * binary hex dump.
 */
const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml'
};

const AUDIO_MIME_BY_EXT: Readonly<Record<string, string>> = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.m4a': 'audio/mp4'
};

const VIDEO_MIME_BY_EXT: Readonly<Record<string, string>> = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.ogv': 'video/ogg'
};

interface MagicBytesProbe {
    isImage?: string;
    isAudio?: string;
    isVideo?: string;
}

/**
 * Best-effort magic-byte sniff for the formats the inline preview can render.
 * Unlike the archive container sniff in `archive.ts`, this looks specifically
 * for media payloads (images, audio, video). Returns the matching MIME type
 * if any signature window matches.
 */
function probeMediaMagicBytes(bytes: Uint8Array): MagicBytesProbe {
    if (bytes.length < 4) return {};
    const startsWith = (sig: number[]): boolean => {
        if (bytes.length < sig.length) return false;
        for (let i = 0; i < sig.length; i++) {
            if (bytes[i] !== sig[i]) return false;
        }
        return true;
    };
    const matchesAt = (offset: number, sig: number[]): boolean => {
        if (bytes.length < offset + sig.length) return false;
        for (let i = 0; i < sig.length; i++) {
            if (bytes[offset + i] !== sig[i]) return false;
        }
        return true;
    };

    // Images
    if (startsWith([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return { isImage: 'image/png' };
    if (startsWith([0xFF, 0xD8, 0xFF])) return { isImage: 'image/jpeg' };
    if (startsWith([0x47, 0x49, 0x46, 0x38])) return { isImage: 'image/gif' };
    if (startsWith([0x42, 0x4D])) return { isImage: 'image/bmp' };
    // RIFF...WEBP
    if (startsWith([0x52, 0x49, 0x46, 0x46]) && matchesAt(8, [0x57, 0x45, 0x42, 0x50])) {
        return { isImage: 'image/webp' };
    }
    // RIFF...WAVE
    if (startsWith([0x52, 0x49, 0x46, 0x46]) && matchesAt(8, [0x57, 0x41, 0x56, 0x45])) {
        return { isAudio: 'audio/wav' };
    }
    // FLAC
    if (startsWith([0x66, 0x4C, 0x61, 0x43])) return { isAudio: 'audio/flac' };
    // OGG (could be audio or video — default to audio; explicit `.ogv` ext upgrades to video)
    if (startsWith([0x4F, 0x67, 0x67, 0x53])) return { isAudio: 'audio/ogg' };
    // MP3 ID3 tag
    if (startsWith([0x49, 0x44, 0x33])) return { isAudio: 'audio/mpeg' };
    // MP3 frame sync (FF Fx)
    if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) return { isAudio: 'audio/mpeg' };
    // ISO base media (mp4/m4a/mov): "ftyp" at offset 4
    if (matchesAt(4, [0x66, 0x74, 0x79, 0x70])) {
        // Sub-brand at offset 8 disambiguates audio vs video; without finer
        // probing we route by extension hint at the caller and default to
        // mp4 video here.
        return { isVideo: 'video/mp4' };
    }
    // Matroska / WebM EBML
    if (startsWith([0x1A, 0x45, 0xDF, 0xA3])) return { isVideo: 'video/webm' };
    // SVG: starts with optional BOM/whitespace + "<?xml" or "<svg"
    if (looksLikeSvg(bytes)) return { isImage: 'image/svg+xml' };
    return {};
}

function looksLikeSvg(bytes: Uint8Array): boolean {
    const sample = bytes.subarray(0, Math.min(bytes.length, 512));
    let text = '';
    try {
        text = utf8Decoder().decode(sample);
    } catch {
        return false;
    }
    const trimmed = text.replace(/^﻿/, '').trimStart().toLowerCase();
    return trimmed.startsWith('<?xml') ? trimmed.includes('<svg') : trimmed.startsWith('<svg');
}

/**
 * "Looks textual?" heuristic. Mirrors the helper in
 * `templates/archive/js/archiveViewerMain.ts` so the classifier and the
 * viewer agree on what counts as text. We sample the first 8 KB for NUL
 * bytes (binary tell) and the density of unusual control characters.
 */
function looksLikeText(bytes: Uint8Array): boolean {
    const sampleSize = Math.min(bytes.length, 8192);
    if (sampleSize === 0) return true;
    let suspicious = 0;
    for (let i = 0; i < sampleSize; i += 1) {
        const byte = bytes[i];
        if (byte === 0) return false;
        const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12;
        if (isControl) suspicious += 1;
    }
    return suspicious / sampleSize <= 0.02;
}

function lookupMimeByExtension(entryPath: string): { kind: 'image' | 'audio' | 'video'; mime: string } | null {
    const ext = getExtension(entryPath);
    if (!ext) return null;
    if (IMAGE_MIME_BY_EXT[ext]) return { kind: 'image', mime: IMAGE_MIME_BY_EXT[ext] };
    if (AUDIO_MIME_BY_EXT[ext]) return { kind: 'audio', mime: AUDIO_MIME_BY_EXT[ext] };
    if (VIDEO_MIME_BY_EXT[ext]) return { kind: 'video', mime: VIDEO_MIME_BY_EXT[ext] };
    return null;
}

/** Render a Uint8Array as a hex+ASCII dump. */
function toHexDump(bytes: Uint8Array, limit: number): string {
    const length = Math.min(bytes.length, limit);
    const lines: string[] = [];
    for (let offset = 0; offset < length; offset += 16) {
        const slice = bytes.subarray(offset, Math.min(offset + 16, length));
        const hex = Array.from(slice)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ')
            .padEnd(16 * 3 - 1, ' ');
        const ascii = Array.from(slice)
            .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
            .join('');
        lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
    }
    if (bytes.length > limit) {
        lines.push(`... (${bytes.length - limit} more bytes)`);
    }
    return lines.join('\n');
}

/**
 * Decide how the archive viewer should render a freshly-extracted entry.
 *
 * Detection rules (extension first, then magic bytes):
 *   1. Extension matches a known media format → return the matching kind.
 *   2. Magic bytes match a known media format → return the matching kind.
 *   3. Bytes look textual → `text` (or `too-large` past the cap).
 *   4. Otherwise → `binary` with a hex dump of the leading 4 KB.
 *
 * The function is pure — it never allocates ObjectURLs. The viewer is
 * responsible for `URL.createObjectURL`/`revokeObjectURL` so it can manage
 * lifecycle on its side.
 */
export function classifyArchivePreview(
    entryPath: string,
    bytes: Uint8Array
): ArchivePreviewClassification {
    const byteLength = bytes.length;
    if (byteLength === 0) {
        return { kind: 'text', text: '', byteLength };
    }

    const extLookup = lookupMimeByExtension(entryPath);
    const magic = probeMediaMagicBytes(bytes);

    // Resolve image / audio / video first when either source agrees.
    if (extLookup?.kind === 'image' || magic.isImage) {
        return {
            kind: 'image',
            mime: extLookup?.kind === 'image' ? extLookup.mime : magic.isImage,
            byteLength
        };
    }
    if (extLookup?.kind === 'audio' || magic.isAudio) {
        return {
            kind: 'audio',
            mime: extLookup?.kind === 'audio' ? extLookup.mime : magic.isAudio,
            byteLength
        };
    }
    if (extLookup?.kind === 'video' || magic.isVideo) {
        return {
            kind: 'video',
            mime: extLookup?.kind === 'video' ? extLookup.mime : magic.isVideo,
            byteLength
        };
    }

    if (looksLikeText(bytes)) {
        if (byteLength > ARCHIVE_TEXT_PREVIEW_LIMIT) {
            return { kind: 'too-large', byteLength };
        }
        const text = utf8Decoder().decode(bytes);
        return { kind: 'text', text, byteLength };
    }

    return {
        kind: 'binary',
        hex: toHexDump(bytes, ARCHIVE_HEX_PREVIEW_LIMIT),
        byteLength
    };
}
