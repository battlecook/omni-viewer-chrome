// Browser port of vscode-omni-viewer/src/utils/fileUtils.ts.
//
// All node:fs / Buffer / child_process dependencies are removed. Detection now
// operates on a `File` (or `Blob`-shaped object) and returns a Promise.
//
// Public API:
//   FileUtils.detectViewerType(file, requestedViewType?) => Promise<FileViewerDetectionResult>
//   FileUtils.getAudioMimeType(name) / getVideoMimeType(name) / getImageMimeType(name)
//
// All 24 file-signature cases listed in issue #3 are covered.

import { listZipEntryNames, JSZipLike } from './fileUtils/archive';
import {
    extOf,
    getAudioMimeType as resolveAudioMimeType,
    getImageMimeType as resolveImageMimeType,
    getVideoMimeType as resolveVideoMimeType,
    getAudioMetadata as readAudioMetadata,
    AudioMetadata
} from './fileUtils/media';
import { detectDelimiter } from './fileUtils/tabular';

export type OmniViewerViewType =
    | 'omni-viewer.audioViewer'
    | 'omni-viewer.videoViewer'
    | 'omni-viewer.imageViewer'
    | 'omni-viewer.archiveViewer'
    | 'omni-viewer.csvViewer'
    | 'omni-viewer.jsonViewer'
    | 'omni-viewer.yamlViewer'
    | 'omni-viewer.jsonlViewer'
    | 'omni-viewer.tomlViewer'
    | 'omni-viewer.markdownViewer'
    | 'omni-viewer.latexViewer'
    | 'omni-viewer.mermaidViewer'
    | 'omni-viewer.plantumlViewer'
    | 'omni-viewer.automotiveViewer'
    | 'omni-viewer.avroViewer'
    | 'omni-viewer.bagViewer'
    | 'omni-viewer.stpViewer'
    | 'omni-viewer.db3Viewer'
    | 'omni-viewer.reqifViewer'
    | 'omni-viewer.pcapViewer'
    | 'omni-viewer.pcapngViewer'
    | 'omni-viewer.hdf5Viewer'
    | 'omni-viewer.numpyViewer'
    | 'omni-viewer.ggufViewer'
    | 'omni-viewer.onnxViewer'
    | 'omni-viewer.tfliteViewer'
    | 'omni-viewer.kerasViewer'
    | 'omni-viewer.coremlViewer'
    | 'omni-viewer.openvinoViewer'
    | 'omni-viewer.safetensorsViewer'
    | 'omni-viewer.parquetViewer'
    | 'omni-viewer.hwpViewer'
    | 'omni-viewer.psdViewer'
    | 'omni-viewer.excelViewer'
    | 'omni-viewer.wordViewer'
    | 'omni-viewer.pdfViewer'
    | 'omni-viewer.pptViewer';

export interface FileViewerDetectionResult {
    viewType: OmniViewerViewType | null;
    reason: string;
    matchedBySignature: boolean;
}

export interface DetectViewerTypeOptions {
    /** Optional fallback viewer type when no strong signature matches. */
    fallbackViewType?: OmniViewerViewType;
    /**
     * Optional JSZip instance for ZIP-based Office disambiguation. When omitted,
     * a manual local-file-header parser is used. Callers can lazy-load
     * `vendor/jszip.min.js` and pass the resulting global here.
     */
    jsZip?: JSZipLike;
}

const SIGNATURE_READ_SIZE = 64 * 1024;
const RAW_AUDIO_EXTENSIONS = new Set(['.pcm']);

// Issue #32 — video container extensions that should ALWAYS route to the
// video viewer, even when no byte signature matches. The set covers the
// extensions added to `manifest.json#file_handlers.accept` in #5
// (`.mts`/`.m2ts`/`.avi`/`.wmv`/`.flv`/`.mkv`/`.m4v`/`.ogv`) plus the original
// `.mov`/`.webm`/`.mp4` ones, so a truncated or codec-only fragment whose
// container header was stripped still lands in the right viewer. Browser
// codec support is a separate question — the viewer's `<video>` element
// surfaces an unsupported-codec fallback panel when it can't decode.
const VIDEO_EXTENSION_FALLBACK = new Set([
    '.mp4',
    '.m4v',
    '.mov',
    '.webm',
    '.mkv',
    '.avi',
    '.wmv',
    '.flv',
    '.mts',
    '.m2ts',
    '.ts',
    '.ogv'
]);
const AUTOMOTIVE_TEXT_EXTENSIONS = new Set(['.dbc', '.arxml', '.a2l', '.asc']);
const AUTOMOTIVE_BINARY_EXTENSIONS = new Set(['.blf', '.mf4', '.mdf']);
const STRUCTURED_DATA_TEXT_EXTENSIONS = new Set(['.stp', '.step', '.reqif']);
const LATEX_EXTENSIONS = new Set(['.tex', '.latex', '.ltx']);
const STRUCTURED_DATA_BINARY_EXTENSIONS = new Set(['.avro', '.bag', '.db3', '.sqlite', '.sqlite3', '.pcap', '.pcapng', '.h5', '.hdf5']);

// Lazy decoders — jest-environment-jsdom 29 does not expose `TextDecoder`
// as a global at module-load time. Constructing decoders on first use lets
// the same module work in jsdom, in Chrome, and (via getTextDecoder) when a
// test file polyfills them late.
let _utf8Decoder: TextDecoder | null = null;
let _latin1Decoder: TextDecoder | null = null;

function utf8Decoder(): TextDecoder {
    if (!_utf8Decoder) {
        _utf8Decoder = new TextDecoder('utf-8');
    }
    return _utf8Decoder;
}

function latin1Decoder(): TextDecoder {
    if (!_latin1Decoder) {
        _latin1Decoder = new TextDecoder('latin1');
    }
    return _latin1Decoder;
}

/**
 * Reads a `Blob` (or `File`) into an `ArrayBuffer`. Wraps `Blob.arrayBuffer()`
 * for Chrome (and modern jsdom) while falling back to `FileReader` for
 * environments — notably `jest-environment-jsdom@29` — that ship a `Blob`
 * implementation without an `arrayBuffer` method.
 */
async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    const maybe = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
    if (typeof maybe.arrayBuffer === 'function') {
        return maybe.arrayBuffer();
    }
    if (typeof FileReader !== 'undefined') {
        return new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
            reader.onload = () => {
                const result = reader.result;
                if (result instanceof ArrayBuffer) {
                    resolve(result);
                } else {
                    reject(new Error('Unexpected FileReader result type'));
                }
            };
            reader.readAsArrayBuffer(blob);
        });
    }
    throw new Error('No mechanism available to read Blob into ArrayBuffer.');
}

export class FileUtils {
    private static readonly SIGNATURE_READ_SIZE = SIGNATURE_READ_SIZE;

    /**
     * Detect the most appropriate viewer type for a `File` object.
     *
     * Equivalent to vscode-omni-viewer's `FileUtils.detectViewerType` but
     * adapted to the browser: receives a `File` instead of a path, and uses
     * `File.slice` + `arrayBuffer()` to read the signature window without
     * loading the entire file.
     */
    public static async detectViewerType(
        file: File,
        requestedOrOptions?: OmniViewerViewType | DetectViewerTypeOptions
    ): Promise<FileViewerDetectionResult> {
        const options: DetectViewerTypeOptions =
            typeof requestedOrOptions === 'string'
                ? { fallbackViewType: requestedOrOptions }
                : requestedOrOptions ?? {};

        const fallbackViewType = options.fallbackViewType;
        const buffer = await this.readSignatureBuffer(file);
        const ext = extOf(file.name);
        const bufferLength = buffer.length;
        const preferredOfficeViewType = this.getOfficeViewTypeForExtension(ext);

        if (bufferLength === 0) {
            return {
                viewType: fallbackViewType ?? null,
                reason: 'The file is empty, so the extension fallback was used.',
                matchedBySignature: false
            };
        }

        if (this.hasAsciiPrefix(buffer, '%PDF-')) {
            return this.signatureMatch('omni-viewer.pdfViewer', 'Matched the PDF header.');
        }

        if (this.matchesBytes(buffer, [0x38, 0x42, 0x50, 0x53])) {
            return this.signatureMatch('omni-viewer.psdViewer', 'Matched the PSD signature.');
        }

        if (this.matchesBytes(buffer, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) {
            return this.signatureMatch('omni-viewer.imageViewer', 'Matched the PNG signature.');
        }

        if (this.matchesBytes(buffer, [0xFF, 0xD8, 0xFF])) {
            return this.signatureMatch('omni-viewer.imageViewer', 'Matched the JPEG signature.');
        }

        if (this.hasAsciiPrefix(buffer, 'GIF87a') || this.hasAsciiPrefix(buffer, 'GIF89a')) {
            return this.signatureMatch('omni-viewer.imageViewer', 'Matched the GIF signature.');
        }

        if (this.matchesBytes(buffer, [0x42, 0x4D])) {
            return this.signatureMatch('omni-viewer.imageViewer', 'Matched the BMP signature.');
        }

        if (this.hasAsciiPrefix(buffer.subarray(8), 'WEBP') && this.hasAsciiPrefix(buffer, 'RIFF')) {
            return this.signatureMatch('omni-viewer.imageViewer', 'Matched the WebP RIFF signature.');
        }

        if (this.isSvg(buffer)) {
            return this.signatureMatch('omni-viewer.imageViewer', 'Matched SVG markup.');
        }

        if (this.hasAsciiPrefix(buffer, 'fLaC')) {
            return this.signatureMatch('omni-viewer.audioViewer', 'Matched the FLAC signature.');
        }

        if (this.hasAsciiPrefix(buffer, 'OggS')) {
            return this.signatureMatch('omni-viewer.audioViewer', 'Matched the OGG container signature.');
        }

        if (this.hasAsciiPrefix(buffer, 'ID3') || this.isMp3FrameHeader(buffer)) {
            return this.signatureMatch('omni-viewer.audioViewer', 'Matched MP3 frame metadata.');
        }

        if (this.hasAsciiPrefix(buffer, 'RIFF') && this.hasAsciiPrefix(buffer.subarray(8), 'WAVE')) {
            return this.signatureMatch('omni-viewer.audioViewer', 'Matched the WAV RIFF signature.');
        }

        if (this.isAiff(buffer)) {
            return this.signatureMatch('omni-viewer.audioViewer', 'Matched the AIFF FORM container signature.');
        }

        if (this.isAc3(buffer)) {
            return this.signatureMatch('omni-viewer.audioViewer', 'Matched the AC-3 sync word.');
        }

        if (this.isAmr(buffer)) {
            return this.signatureMatch('omni-viewer.audioViewer', 'Matched the AMR file header.');
        }

        if (this.isAacAdts(buffer)) {
            return this.signatureMatch('omni-viewer.audioViewer', 'Matched AAC ADTS sync bytes.');
        }

        if (this.hasAsciiPrefix(buffer, 'RIFF') && this.hasAsciiPrefix(buffer.subarray(8), 'AVI ')) {
            return this.signatureMatch('omni-viewer.videoViewer', 'Matched the AVI RIFF signature.');
        }

        if (this.isMp4Family(buffer)) {
            if (ext === '.m4a') {
                return this.signatureMatch('omni-viewer.audioViewer', 'Matched an MP4-family container and the .m4a extension.');
            }
            return this.signatureMatch('omni-viewer.videoViewer', 'Matched an MP4-family container signature.');
        }

        if (this.matchesBytes(buffer, [0x1A, 0x45, 0xDF, 0xA3])) {
            if (ext === '.webm' || ext === '.mkv') {
                return this.signatureMatch('omni-viewer.videoViewer', 'Matched the EBML signature used by WebM/Matroska.');
            }
        }

        if (this.isMpegTransportStream(buffer)) {
            return this.signatureMatch('omni-viewer.videoViewer', 'Matched MPEG transport stream sync packets.');
        }

        // Issue #32 — FLV ("FLV\x01") and WMV/ASF (GUID
        // 30 26 B2 75 8E 66 CF 11 A6 D9 00 AA 00 62 CE 6C) container
        // signatures. Even if the browser can't decode the inner codec, we
        // still want the file to land in the video viewer so the
        // unsupported-codec fallback panel can offer a download.
        if (this.matchesBytes(buffer, [0x46, 0x4C, 0x56, 0x01])) {
            return this.signatureMatch('omni-viewer.videoViewer', 'Matched the FLV container signature.');
        }

        if (this.isAsfContainer(buffer)) {
            return this.signatureMatch('omni-viewer.videoViewer', 'Matched the ASF/WMV container signature.');
        }

        if (await this.isParquet(file, buffer)) {
            return this.signatureMatch('omni-viewer.parquetViewer', 'Matched the Parquet magic bytes.');
        }

        if (this.matchesBytes(buffer, [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])) {
            // Keras 2 wrote its models as plain HDF5, and only the contents
            // tell such a file apart from any other HDF5 one. So `.h5` stays
            // with the HDF5 viewer, and only a declared `.keras` name moves it
            // to the Keras viewer — which reads both save formats.
            if (ext === '.keras') {
                return this.signatureMatch('omni-viewer.kerasViewer', 'Matched the HDF5 signature under the Keras extension.');
            }
            return this.signatureMatch('omni-viewer.hdf5Viewer', 'Matched the HDF5 signature.');
        }

        if (this.matchesBytes(buffer, [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59])) {
            return this.signatureMatch('omni-viewer.numpyViewer', 'Matched the NumPy NPY magic bytes.');
        }

        if (this.hasAsciiPrefix(buffer, 'GGUF')) {
            return this.signatureMatch('omni-viewer.ggufViewer', 'Matched the GGUF magic bytes.');
        }

        if (this.hasAsciiPrefix(buffer.subarray(4), 'TFL3')) {
            return this.signatureMatch('omni-viewer.tfliteViewer', 'Matched the TFLite TFL3 identifier.');
        }

        if (this.isSafetensors(file, buffer)) {
            return this.signatureMatch('omni-viewer.safetensorsViewer', 'Matched the safetensors header layout.');
        }

        if (this.hasAsciiPrefix(buffer, 'LOGG')) {
            return this.signatureMatch('omni-viewer.automotiveViewer', 'Matched the Vector BLF file signature.');
        }

        if (this.isMdfFile(buffer)) {
            return this.signatureMatch('omni-viewer.automotiveViewer', 'Matched the MDF/MF4 file signature.');
        }

        if (this.hasAsciiPrefix(buffer, 'Obj\x01')) {
            return this.signatureMatch('omni-viewer.avroViewer', 'Matched the Avro object container signature.');
        }

        if (this.hasAsciiPrefix(buffer, '#ROSBAG V2.')) {
            return this.signatureMatch('omni-viewer.bagViewer', 'Matched the ROS bag header.');
        }

        if (this.hasAsciiPrefix(buffer, 'SQLite format 3\0')) {
            return this.signatureMatch('omni-viewer.db3Viewer', 'Matched the SQLite 3 database header.');
        }

        if (this.isPcapClassic(buffer)) {
            return this.signatureMatch('omni-viewer.pcapViewer', 'Matched the PCAP global header magic bytes.');
        }

        if (this.isPcapng(buffer)) {
            return this.signatureMatch('omni-viewer.pcapngViewer', 'Matched the PCAPNG section header block.');
        }

        if (this.isCompoundFileBinary(buffer)) {
            if (preferredOfficeViewType) {
                return this.signatureMatch(
                    preferredOfficeViewType,
                    `Matched the Compound File signature and preserved the ${ext} Office viewer.`
                );
            }

            const compoundType = this.detectCompoundFileViewType(buffer);
            if (compoundType) {
                return this.signatureMatch(compoundType.viewType, compoundType.reason);
            }
        }

        if (this.matchesBytes(buffer, [0x50, 0x4B, 0x03, 0x04])) {
            // NPZ is a ZIP container whose members are NPY arrays. The .npz
            // extension is the only reliable way to distinguish it from a
            // generic ZIP before the core validates and reads its entries.
            if (ext === '.npz') {
                return this.signatureMatch('omni-viewer.numpyViewer', 'Matched a NumPy NPZ ZIP container.');
            }

            // A Keras 3 model is a ZIP with no distinguishing leading bytes.
            // The extension settles it here; an extensionless one still lands
            // in the viewer through the member scan below.
            if (ext === '.keras') {
                return this.signatureMatch('omni-viewer.kerasViewer', 'Matched a Keras ZIP container.');
            }

            // An `.mlpackage` is a directory bundle on disk, so what a browser
            // can hand over is the zipped bundle. The extension settles it
            // here; a renamed one still lands in the viewer through the member
            // scan below.
            if (ext === '.mlpackage') {
                return this.signatureMatch('omni-viewer.coremlViewer', 'Matched a Core ML package ZIP container.');
            }

            if (preferredOfficeViewType) {
                return this.signatureMatch(
                    preferredOfficeViewType,
                    `Matched a ZIP-based Office container and preserved the ${ext} Office viewer.`
                );
            }

            const zipType = await this.detectZipBasedOfficeViewType(file, options.jsZip);
            if (zipType) {
                return this.signatureMatch(zipType.viewType, zipType.reason);
            }

            return this.signatureMatch('omni-viewer.archiveViewer', 'Matched the ZIP archive signature.');
        }

        if (this.matchesBytes(buffer, [0x1F, 0x8B])) {
            return this.signatureMatch('omni-viewer.archiveViewer', 'Matched the GZIP archive signature.');
        }

        if (this.hasAsciiPrefix(buffer, 'BZh')) {
            return this.signatureMatch('omni-viewer.archiveViewer', 'Matched the BZIP2 archive signature.');
        }

        if (this.matchesBytes(buffer, [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00])) {
            return this.signatureMatch('omni-viewer.archiveViewer', 'Matched the XZ archive signature.');
        }

        if (this.matchesBytes(buffer, [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])) {
            return this.signatureMatch('omni-viewer.archiveViewer', 'Matched the 7-Zip archive signature.');
        }

        if (this.matchesBytes(buffer, [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00])) {
            return this.signatureMatch('omni-viewer.archiveViewer', 'Matched the RAR v4 archive signature.');
        }

        if (this.matchesBytes(buffer, [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00])) {
            return this.signatureMatch('omni-viewer.archiveViewer', 'Matched the RAR v5 archive signature.');
        }

        if (this.isTarArchive(buffer)) {
            return this.signatureMatch('omni-viewer.archiveViewer', 'Matched the TAR archive signature.');
        }

        if (RAW_AUDIO_EXTENSIONS.has(ext)) {
            return {
                viewType: 'omni-viewer.audioViewer',
                reason: 'Used the raw audio extension fallback.',
                matchedBySignature: false
            };
        }

        // Issue #32 — video container extension fallback. This must run
        // BEFORE `detectTextBasedViewType` so a stray ASCII byte at the head
        // of a stripped/truncated container doesn't cause `.avi` / `.wmv`
        // / `.flv` / `.mkv` / `.mts` / `.m2ts` to be misclassified as a
        // delimited text file.
        if (VIDEO_EXTENSION_FALLBACK.has(ext)) {
            return {
                viewType: 'omni-viewer.videoViewer',
                reason: `Used the video extension fallback for ${ext}.`,
                matchedBySignature: false
            };
        }

        if (AUTOMOTIVE_BINARY_EXTENSIONS.has(ext)) {
            return {
                viewType: 'omni-viewer.automotiveViewer',
                reason: `Used the automotive binary extension fallback for ${ext}.`,
                matchedBySignature: false
            };
        }

        if (STRUCTURED_DATA_BINARY_EXTENSIONS.has(ext)) {
            return {
                viewType: this.viewTypeForStructuredDataExtension(ext),
                reason: `Used the structured data extension fallback for ${ext}.`,
                matchedBySignature: false
            };
        }

        if (ext === '.npy' || ext === '.npz') {
            return {
                viewType: 'omni-viewer.numpyViewer',
                reason: `Used the NumPy extension fallback for ${ext}.`,
                matchedBySignature: false
            };
        }

        if (ext === '.gguf') {
            return {
                viewType: 'omni-viewer.ggufViewer',
                reason: 'Used the GGUF extension fallback.',
                matchedBySignature: false
            };
        }

        // ONNX models are bare protobuf — no magic bytes to key off, so the
        // extension is the only reliable signal.
        if (ext === '.onnx') {
            return {
                viewType: 'omni-viewer.onnxViewer',
                reason: 'Used the ONNX extension fallback.',
                matchedBySignature: false
            };
        }

        if (ext === '.tflite' || ext === '.lite') {
            return {
                viewType: 'omni-viewer.tfliteViewer',
                reason: 'Used the TFLite extension fallback.',
                matchedBySignature: false
            };
        }

        // Reached when a `.keras` file no longer carries its ZIP header — the
        // viewer reports the damage better than the raw-data fallback does.
        if (ext === '.keras') {
            return {
                viewType: 'omni-viewer.kerasViewer',
                reason: 'Used the Keras extension fallback.',
                matchedBySignature: false
            };
        }

        // A `.mlmodel` is a bare protobuf with no leading magic, so — as with
        // ONNX — the extension is the only signal available here. `.mlpackage`
        // reaches this point only when its ZIP header is gone.
        if (ext === '.mlmodel' || ext === '.mlpackage') {
            return {
                viewType: 'omni-viewer.coremlViewer',
                reason: `Used the Core ML extension fallback for ${ext}.`,
                matchedBySignature: false
            };
        }

        if (ext === '.safetensors') {
            return {
                viewType: 'omni-viewer.safetensorsViewer',
                reason: 'Used the safetensors extension fallback.',
                matchedBySignature: false
            };
        }

        const textType = this.detectTextBasedViewType(buffer, ext);
        if (textType) {
            return textType;
        }

        if (this.isArchiveExtension(file.name)) {
            return {
                viewType: 'omni-viewer.archiveViewer',
                reason: 'Used the archive extension fallback.',
                matchedBySignature: false
            };
        }

        return {
            viewType: fallbackViewType ?? null,
            reason: fallbackViewType
                ? 'No strong file signature matched, so the extension fallback was used.'
                : 'No supported file signature matched.',
            matchedBySignature: false
        };
    }

    public static getAudioMimeType(fileName: string): string {
        return resolveAudioMimeType(fileName);
    }

    public static getVideoMimeType(fileName: string): string {
        return resolveVideoMimeType(fileName);
    }

    public static getImageMimeType(fileName: string): string {
        return resolveImageMimeType(fileName);
    }

    public static async getAudioMetadata(file: File): Promise<AudioMetadata> {
        return readAudioMetadata(file);
    }

    private static signatureMatch(viewType: OmniViewerViewType, reason: string): FileViewerDetectionResult {
        return { viewType, reason, matchedBySignature: true };
    }

    private static getOfficeViewTypeForExtension(ext: string): OmniViewerViewType | null {
        switch (ext) {
        case '.doc':
        case '.docx':
            return 'omni-viewer.wordViewer';
        case '.xls':
        case '.xlsx':
            return 'omni-viewer.excelViewer';
        case '.ppt':
        case '.pptx':
            return 'omni-viewer.pptViewer';
        case '.hwp':
        case '.hwpx':
            return 'omni-viewer.hwpViewer';
        default:
            return null;
        }
    }

    private static async readSignatureBuffer(file: File): Promise<Uint8Array> {
        const slice = file.slice(0, this.SIGNATURE_READ_SIZE);
        const arrayBuffer = await blobToArrayBuffer(slice);
        return new Uint8Array(arrayBuffer);
    }

    private static matchesBytes(buffer: Uint8Array, signature: number[], offset = 0): boolean {
        if (buffer.length < offset + signature.length) {
            return false;
        }
        return signature.every((byte, index) => buffer[offset + index] === byte);
    }

    private static hasAsciiPrefix(buffer: Uint8Array, value: string): boolean {
        if (buffer.length < value.length) {
            return false;
        }
        for (let i = 0; i < value.length; i++) {
            if (buffer[i] !== value.charCodeAt(i)) {
                return false;
            }
        }
        return true;
    }

    private static isTarArchive(buffer: Uint8Array): boolean {
        if (buffer.length < 262) {
            return false;
        }
        return latin1Decoder().decode(buffer.subarray(257, 262)) === 'ustar';
    }

    private static isArchiveExtension(fileName: string): boolean {
        const lowerPath = fileName.toLowerCase();
        return lowerPath.endsWith('.zip')
            || lowerPath.endsWith('.rar')
            || lowerPath.endsWith('.7z')
            || lowerPath.endsWith('.dmg')
            || lowerPath.endsWith('.jar')
            || lowerPath.endsWith('.apk')
            || lowerPath.endsWith('.tar')
            || lowerPath.endsWith('.tgz')
            || lowerPath.endsWith('.tbz2')
            || lowerPath.endsWith('.txz')
            || lowerPath.endsWith('.tar.gz')
            || lowerPath.endsWith('.tar.bz2')
            || lowerPath.endsWith('.tar.xz')
            || lowerPath.endsWith('.gz')
            || lowerPath.endsWith('.bz2')
            || lowerPath.endsWith('.xz');
    }

    private static isSvg(buffer: Uint8Array): boolean {
        const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
        const snippet = utf8Decoder().decode(sample).trimStart();
        return snippet.startsWith('<svg') || (snippet.startsWith('<?xml') && snippet.includes('<svg'));
    }

    private static isMp3FrameHeader(buffer: Uint8Array): boolean {
        return buffer.length >= 2
            && buffer[0] === 0xFF
            && (buffer[1] & 0xE0) === 0xE0;
    }

    private static isAacAdts(buffer: Uint8Array): boolean {
        return buffer.length >= 2
            && buffer[0] === 0xFF
            && (buffer[1] & 0xF6) === 0xF0;
    }

    private static isAiff(buffer: Uint8Array): boolean {
        if (buffer.length < 12 || !this.hasAsciiPrefix(buffer, 'FORM')) {
            return false;
        }
        const tag = latin1Decoder().decode(buffer.subarray(8, 12));
        return tag === 'AIFF' || tag === 'AIFC';
    }

    private static isAc3(buffer: Uint8Array): boolean {
        return buffer.length >= 2
            && buffer[0] === 0x0B
            && buffer[1] === 0x77;
    }

    private static isAmr(buffer: Uint8Array): boolean {
        return this.hasAsciiPrefix(buffer, '#!AMR\n') || this.hasAsciiPrefix(buffer, '#!AMR-WB\n');
    }

    /**
     * Issue #32 — recognise the ASF/WMV/WMA container by its 16-byte top-level
     * GUID. Spec: ASF "Header Object" begins with the GUID
     * `30 26 B2 75 8E 66 CF 11 A6 D9 00 AA 00 62 CE 6C`. WMV files always
     * lead with this header, so matching it lets us route `.wmv` (and any
     * other ASF-wrapped media) to the video viewer even when the file
     * extension is wrong.
     */
    private static isAsfContainer(buffer: Uint8Array): boolean {
        return this.matchesBytes(buffer, [
            0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11,
            0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C
        ]);
    }

    private static isMpegTransportStream(buffer: Uint8Array): boolean {
        const packetSize = 188;
        if (buffer.length < packetSize * 3) {
            return false;
        }
        return buffer[0] === 0x47
            && buffer[packetSize] === 0x47
            && buffer[packetSize * 2] === 0x47;
    }

    private static isMp4Family(buffer: Uint8Array): boolean {
        if (buffer.length < 12) {
            return false;
        }
        return latin1Decoder().decode(buffer.subarray(4, 8)) === 'ftyp';
    }

    private static async isParquet(file: File, headerBuffer: Uint8Array): Promise<boolean> {
        if (!this.hasAsciiPrefix(headerBuffer, 'PAR1')) {
            return false;
        }
        if (file.size < 8) {
            return false;
        }
        const tail = await blobToArrayBuffer(file.slice(file.size - 4, file.size));
        const tailBytes = new Uint8Array(tail);
        return latin1Decoder().decode(tailBytes) === 'PAR1';
    }

    /**
     * A safetensors file has no magic bytes: it opens with a little-endian
     * u64 header length followed by that many bytes of JSON. The shape is
     * still distinctive enough to claim — the declared header must fit inside
     * the file and the byte right after the prefix must start a JSON object.
     */
    private static isSafetensors(file: File, buffer: Uint8Array): boolean {
        if (buffer.length < 10) {
            return false;
        }
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const low = view.getUint32(0, true);
        const high = view.getUint32(4, true);
        // A header past 4 GiB is not a real model, so a non-zero high word
        // means these bytes are something else entirely.
        if (high !== 0 || low < 2 || low > file.size - 8) {
            return false;
        }
        // `{"` for a header with tensors, `{}` for an empty one.
        return buffer[8] === 0x7b && (buffer[9] === 0x22 || buffer[9] === 0x7d);
    }

    private static isMdfFile(buffer: Uint8Array): boolean {
        if (!this.hasAsciiPrefix(buffer, 'MDF')) {
            return false;
        }
        const head = latin1Decoder().decode(buffer.subarray(0, Math.min(buffer.length, 64)));
        return /^MDF\s/.test(head) || head.includes('MDF     ');
    }

    private static isCompoundFileBinary(buffer: Uint8Array): boolean {
        return this.matchesBytes(buffer, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    }

    private static detectCompoundFileViewType(buffer: Uint8Array): { viewType: OmniViewerViewType; reason: string } | null {
        const text = latin1Decoder().decode(buffer);

        if (text.includes('WordDocument')) {
            return {
                viewType: 'omni-viewer.wordViewer',
                reason: 'Matched the Compound File signature and Word stream metadata.'
            };
        }

        if (text.includes('Workbook')) {
            return {
                viewType: 'omni-viewer.excelViewer',
                reason: 'Matched the Compound File signature and Excel workbook metadata.'
            };
        }

        if (text.includes('PowerPoint Document')) {
            return {
                viewType: 'omni-viewer.pptViewer',
                reason: 'Matched the Compound File signature and PowerPoint stream metadata.'
            };
        }

        if (text.includes('FileHeader') || text.includes('HwpSummaryInformation')) {
            return {
                viewType: 'omni-viewer.hwpViewer',
                reason: 'Matched the Compound File signature and HWP stream metadata.'
            };
        }

        return null;
    }

    private static async detectZipBasedOfficeViewType(
        file: File,
        jsZip?: JSZipLike
    ): Promise<{ viewType: OmniViewerViewType; reason: string } | null> {
        try {
            const names = await listZipEntryNames(file, jsZip);

            if (names.some((name) => name.startsWith('word/'))) {
                return {
                    viewType: 'omni-viewer.wordViewer',
                    reason: 'Matched a ZIP container with Word OOXML entries.'
                };
            }

            if (names.some((name) => name.startsWith('xl/'))) {
                return {
                    viewType: 'omni-viewer.excelViewer',
                    reason: 'Matched a ZIP container with Excel OOXML entries.'
                };
            }

            if (names.some((name) => name.startsWith('ppt/'))) {
                return {
                    viewType: 'omni-viewer.pptViewer',
                    reason: 'Matched a ZIP container with PowerPoint OOXML entries.'
                };
            }

            if (
                names.some((name) => /^Contents\/section\d+\.xml$/i.test(name))
                || names.includes('Contents/content.hpf')
                || names.includes('version.xml')
            ) {
                return {
                    viewType: 'omni-viewer.hwpViewer',
                    reason: 'Matched a ZIP container with HWPX package entries.'
                };
            }

            // Neither member is distinctive on its own, so both have to be
            // present before a plain ZIP is claimed as a Keras 3 model
            // (omni-viewer-core registry/probe.ts uses the same pair).
            if (names.includes('config.json') && names.includes('model.weights.h5')) {
                return {
                    viewType: 'omni-viewer.kerasViewer',
                    reason: 'Matched a ZIP container with Keras model entries.'
                };
            }

            // A zipped `.mlpackage` keeps its Manifest.json beside a Data tree
            // reserved to com.apple.CoreML, optionally under the bundle's own
            // folder (omni-viewer-core registry/probe.ts uses the same pair).
            if (
                names.some((name) => name === 'Manifest.json' || name.endsWith('/Manifest.json'))
                && names.some((name) => name.includes('Data/com.apple.CoreML/'))
            ) {
                return {
                    viewType: 'omni-viewer.coremlViewer',
                    reason: 'Matched a ZIP container with Core ML package entries.'
                };
            }
        } catch (error) {
            console.warn('Failed to inspect ZIP-based office file:', error);
        }

        return null;
    }

    private static detectTextBasedViewType(buffer: Uint8Array, ext: string): FileViewerDetectionResult | null {
        const sample = utf8Decoder().decode(buffer.subarray(0, Math.min(buffer.length, 16 * 1024)));
        const lines = sample
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

        if (lines.length === 0) {
            return null;
        }

        // LaTeX detection is extension-only in v1 (omni-viewer-core
        // docs/viewers/latex.md §1), and it runs ahead of the content
        // heuristics below: `\documentclass` documents carry no signature the
        // sniffers recognise, so a .tex file would otherwise be at the mercy
        // of the TOML / PlantUML / delimiter guesses further down.
        if (LATEX_EXTENSIONS.has(ext)) {
            return {
                viewType: 'omni-viewer.latexViewer',
                reason: `Used the LaTeX extension fallback for ${ext}.`,
                matchedBySignature: false
            };
        }

        if (ext === '.jsonl' || ext === '.ndjson' || ext === '.jsonlines' || this.looksLikeJsonl(lines)) {
            return {
                viewType: 'omni-viewer.jsonlViewer',
                reason: 'Matched line-delimited JSON content.',
                matchedBySignature: false
            };
        }

        if (ext === '.json' || this.looksLikeJsonDocument(sample)) {
            return {
                viewType: 'omni-viewer.jsonViewer',
                reason: 'Matched JSON document content.',
                matchedBySignature: false
            };
        }

        // OpenVINO IR. Its `.xml` is shared with every other XML dialect, so
        // — as in omni-viewer-core's registry — the extension claims nothing
        // and only the `<net version>` root with a `<layers>` child routes
        // here. Ahead of the remaining sniffs because an IR's attribute-heavy
        // lines would otherwise read as delimited text.
        if (this.looksLikeOpenVinoIr(sample)) {
            return {
                viewType: 'omni-viewer.openvinoViewer',
                reason: 'Matched an OpenVINO IR <net> document.',
                matchedBySignature: false
            };
        }

        if (ext === '.yaml' || ext === '.yml') {
            return {
                viewType: 'omni-viewer.yamlViewer',
                reason: 'Used the YAML extension fallback.',
                matchedBySignature: false
            };
        }

        if (AUTOMOTIVE_TEXT_EXTENSIONS.has(ext)) {
            return {
                viewType: 'omni-viewer.automotiveViewer',
                reason: `Used the automotive text extension fallback for ${ext}.`,
                matchedBySignature: false
            };
        }

        if (STRUCTURED_DATA_TEXT_EXTENSIONS.has(ext)) {
            return {
                viewType: this.viewTypeForStructuredDataExtension(ext),
                reason: `Used the structured data extension fallback for ${ext}.`,
                matchedBySignature: false
            };
        }

        if (ext === '.toml' || this.looksLikeToml(lines)) {
            return {
                viewType: 'omni-viewer.tomlViewer',
                reason: ext === '.toml' ? 'Used the TOML extension fallback.' : 'Matched TOML table or key/value content.',
                matchedBySignature: false
            };
        }

        if (ext === '.md' || ext === '.markdown') {
            return {
                viewType: 'omni-viewer.markdownViewer',
                reason: 'Used the Markdown extension fallback.',
                matchedBySignature: false
            };
        }

        // Extensionless LaTeX. Kept below the extension-keyed branches above so
        // a named file is never re-routed by its contents, and matched only on
        // `\documentclass` — the marker the core's own text sniff uses, and one
        // no other text format we detect produces.
        if (this.looksLikeLatex(lines)) {
            return {
                viewType: 'omni-viewer.latexViewer',
                reason: 'Matched a LaTeX \\documentclass preamble.',
                matchedBySignature: false
            };
        }

        if (ext === '.mmd' || ext === '.mermaid' || this.looksLikeMermaid(lines)) {
            return {
                viewType: 'omni-viewer.mermaidViewer',
                reason: ext === '.mmd' || ext === '.mermaid'
                    ? 'Used the Mermaid extension fallback.'
                    : 'Matched Mermaid diagram syntax.',
                matchedBySignature: false
            };
        }

        if (ext === '.puml' || ext === '.plantuml' || ext === '.iuml' || this.looksLikePlantUml(lines)) {
            return {
                viewType: 'omni-viewer.plantumlViewer',
                reason: ext === '.puml' || ext === '.plantuml' || ext === '.iuml'
                    ? 'Used the PlantUML extension fallback.'
                    : 'Matched PlantUML diagram syntax.',
                matchedBySignature: false
            };
        }

        if (ext === '.csv' || ext === '.tsv') {
            return {
                viewType: 'omni-viewer.csvViewer',
                reason: 'Used the delimited text extension fallback.',
                matchedBySignature: false
            };
        }

        const delimiter = detectDelimiter(lines.slice(0, 10));
        if (delimiter) {
            return {
                viewType: 'omni-viewer.csvViewer',
                reason: `Detected repeated "${delimiter}" delimiters in text rows.`,
                matchedBySignature: false
            };
        }

        return null;
    }

    private static looksLikeJsonl(lines: string[]): boolean {
        if (lines.length < 2) {
            return false;
        }

        const sampleLines = lines.slice(0, 10);
        return sampleLines.every((line) => {
            try {
                const parsed = JSON.parse(line);
                return typeof parsed === 'object' && parsed !== null;
            } catch {
                return false;
            }
        });
    }

    private static looksLikeJsonDocument(sample: string): boolean {
        const trimmed = sample.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            return false;
        }
        try {
            const parsed = JSON.parse(trimmed);
            return typeof parsed === 'object' && parsed !== null;
        } catch {
            return false;
        }
    }

    private static looksLikeToml(lines: string[]): boolean {
        const sampleLines = lines.slice(0, 20);
        let tableCount = 0;
        let assignmentCount = 0;

        for (const line of sampleLines) {
            if (/^\[\[?[A-Za-z0-9_.\-"'\s]+\]?\]$/.test(line)) {
                tableCount++;
                continue;
            }

            if (/^[A-Za-z0-9_.\-"']+\s*=/.test(line)) {
                assignmentCount++;
            }
        }

        return (tableCount > 0 && assignmentCount > 0) || assignmentCount >= 3;
    }

    private static looksLikeLatex(lines: string[]): boolean {
        // `%` starts a LaTeX comment, so a preamble is commonly preceded by a
        // licence header. Scan past those rather than only checking line one.
        return lines
            .slice(0, 30)
            .some((line) => /^\\documentclass\s*(\[|\{)/.test(line));
    }

    /**
     * Mirror of `looksLikeOpenVinoIr` in omni-viewer-core/parsers/openvino:
     * a lowercase `<net>` root carrying a numeric `version` and holding a
     * `<layers>` element, after any BOM / declaration / comment prologue.
     */
    private static looksLikeOpenVinoIr(sample: string): boolean {
        let text = sample.charCodeAt(0) === 0xfeff ? sample.slice(1) : sample;
        for (;;) {
            text = text.trimStart();
            let closer: string;
            if (text.startsWith('<?')) closer = '?>';
            else if (text.startsWith('<!--')) closer = '-->';
            else break;
            const end = text.indexOf(closer, 2);
            if (end === -1) return false;
            text = text.slice(end + closer.length);
        }
        const root = /^\s*(?:<!DOCTYPE(?:[^[>]|\[[^\]]*\])*>\s*)?<net(?:\s[^>]*)?>/.exec(text);
        if (!root) return false;
        const tag = root[0];
        return /\sversion\s*=\s*["']\d+["']/.test(tag) && /<layers[\s/>]/.test(text.slice(root.index + tag.length));
    }

    private static looksLikeMermaid(lines: string[]): boolean {
        const firstCodeLine = lines.find((line) => !line.startsWith('%%'));
        if (!firstCodeLine) return false;
        return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|journey|gitGraph|pie|quadrantChart|requirementDiagram|mindmap|timeline|zenuml|sankey-beta|block-beta|architecture-beta|packet-beta|xychart-beta)\b/.test(firstCodeLine);
    }

    private static looksLikePlantUml(lines: string[]): boolean {
        const sampleLines = lines.slice(0, 30);
        if (sampleLines.some((line) => /^@start(?:uml|plantuml|mindmap|wbs|gantt|json|yaml|salt|ditaa)?\b/i.test(line))) {
            return true;
        }
        return sampleLines.some((line) => /^(actor|participant|boundary|control|entity|database|collections|queue)\s+/i.test(line)) ||
            sampleLines.some((line) => /^(abstract\s+class|class|interface|enum|annotation)\s+/i.test(line)) ||
            sampleLines.some((line) => /^(:.+;|start|stop|if\s*\(.+\)\s*then\b)/i.test(line));
    }

    private static viewTypeForStructuredDataExtension(ext: string): OmniViewerViewType {
        switch (ext) {
        case '.avro':
            return 'omni-viewer.avroViewer';
        case '.bag':
            return 'omni-viewer.bagViewer';
        case '.stp':
        case '.step':
            return 'omni-viewer.stpViewer';
        case '.db3':
        case '.sqlite':
        case '.sqlite3':
            return 'omni-viewer.db3Viewer';
        case '.reqif':
            return 'omni-viewer.reqifViewer';
        case '.pcap':
            return 'omni-viewer.pcapViewer';
        case '.pcapng':
            return 'omni-viewer.pcapngViewer';
        case '.h5':
        case '.hdf5':
            return 'omni-viewer.hdf5Viewer';
        default:
            return 'omni-viewer.automotiveViewer';
        }
    }

    private static isPcapClassic(buffer: Uint8Array): boolean {
        return this.matchesBytes(buffer, [0xd4, 0xc3, 0xb2, 0xa1])
            || this.matchesBytes(buffer, [0xa1, 0xb2, 0xc3, 0xd4])
            || this.matchesBytes(buffer, [0x4d, 0x3c, 0xb2, 0xa1])
            || this.matchesBytes(buffer, [0xa1, 0xb2, 0x3c, 0x4d]);
    }

    private static isPcapng(buffer: Uint8Array): boolean {
        return this.matchesBytes(buffer, [0x0a, 0x0d, 0x0d, 0x0a]);
    }
}

/**
 * Convenience wrapper around `FileUtils.detectViewerType`. Mirrors the legacy
 * call site in `app.js` (which used short string identifiers like
 * `'image' | 'audio' | ...`) so the SPA can opt into the new detector without a
 * full refactor.
 */
export async function detectShortViewerType(file: File, options?: DetectViewerTypeOptions): Promise<string> {
    const result = await FileUtils.detectViewerType(file, options);
    if (!result.viewType) {
        return 'unknown';
    }
    return shortNameForViewType(result.viewType);
}

export function shortNameForViewType(viewType: OmniViewerViewType): string {
    switch (viewType) {
    case 'omni-viewer.audioViewer':
        return 'audio';
    case 'omni-viewer.videoViewer':
        return 'video';
    case 'omni-viewer.imageViewer':
        return 'image';
    case 'omni-viewer.archiveViewer':
        return 'archive';
    case 'omni-viewer.csvViewer':
        return 'csv';
    case 'omni-viewer.jsonViewer':
        return 'json';
    case 'omni-viewer.yamlViewer':
        return 'yaml';
    case 'omni-viewer.jsonlViewer':
        return 'jsonl';
    case 'omni-viewer.tomlViewer':
        return 'toml';
    case 'omni-viewer.markdownViewer':
        return 'markdown';
    case 'omni-viewer.latexViewer':
        return 'latex';
    case 'omni-viewer.mermaidViewer':
        return 'mermaid';
    case 'omni-viewer.plantumlViewer':
        return 'plantuml';
    case 'omni-viewer.automotiveViewer':
    case 'omni-viewer.avroViewer':
    case 'omni-viewer.bagViewer':
    case 'omni-viewer.stpViewer':
    case 'omni-viewer.db3Viewer':
    case 'omni-viewer.reqifViewer':
    case 'omni-viewer.pcapViewer':
    case 'omni-viewer.pcapngViewer':
        return 'automotive';
    case 'omni-viewer.hdf5Viewer':
        return 'hdf5';
    case 'omni-viewer.numpyViewer':
        return 'numpy';
    case 'omni-viewer.ggufViewer':
        return 'gguf';
    case 'omni-viewer.onnxViewer':
        return 'onnx';
    case 'omni-viewer.tfliteViewer':
        return 'tflite';
    case 'omni-viewer.kerasViewer':
        return 'keras';
    case 'omni-viewer.coremlViewer':
        return 'coreml';
    case 'omni-viewer.openvinoViewer':
        return 'openvino';
    case 'omni-viewer.safetensorsViewer':
        return 'safetensors';
    case 'omni-viewer.parquetViewer':
        return 'parquet';
    case 'omni-viewer.hwpViewer':
        return 'hwp';
    case 'omni-viewer.psdViewer':
        return 'psd';
    case 'omni-viewer.excelViewer':
        return 'excel';
    case 'omni-viewer.wordViewer':
        return 'word';
    case 'omni-viewer.pdfViewer':
        return 'pdf';
    case 'omni-viewer.pptViewer':
        return 'ppt';
    default:
        return 'unknown';
    }
}
