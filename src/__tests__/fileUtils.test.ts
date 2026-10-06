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

import { FileUtils, shortNameForViewType } from '../utils/fileUtils';

/**
 * Browser-side port of vscode-omni-viewer/src/__tests__/fileUtils.test.ts.
 *
 * The original tests exercised a node:fs / Buffer-based detector. In the
 * Chrome MV3 extension we operate on `File` (Blob) objects, so each fixture
 * here is built in-memory via `new Uint8Array([...])` and wrapped in a `File`.
 *
 * Coverage parity with the upstream suite — every signature listed in
 * issue #3 (PNG/JPEG/GIF/WEBP/BMP/PSD/PDF/PARQUET/ZIP/RAR/7Z/GZ/TAR/MP4/AVI/
 * WAV/FLAC/MP3/OGG/AIFF/AMR/CSV/TSV/JSONL) is asserted below.
 */

function makeFile(bytes: Uint8Array | number[] | string, name: string): File {
    let payload: Uint8Array;
    if (typeof bytes === 'string') {
        payload = new TextEncoder().encode(bytes);
    } else if (bytes instanceof Uint8Array) {
        payload = bytes;
    } else {
        payload = new Uint8Array(bytes);
    }
    // jsdom File expects BlobPart[]; passing the Uint8Array directly works.
    return new File([payload], name);
}

function concatBytes(...parts: Array<Uint8Array | number[]>): Uint8Array {
    const arrays = parts.map((part) => (part instanceof Uint8Array ? part : new Uint8Array(part)));
    const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const arr of arrays) {
        out.set(arr, off);
        off += arr.length;
    }
    return out;
}

function asciiBytes(value: string): Uint8Array {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
        out[i] = value.charCodeAt(i) & 0xff;
    }
    return out;
}

/**
 * A minimal safetensors file: an 8-byte little-endian header length, that
 * many bytes of JSON, then the tensor payload the header describes.
 */
function makeSafetensorsBytes(): Uint8Array {
    const header = asciiBytes(
        '{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}'
    );
    const out = new Uint8Array(8 + header.length + 4);
    new DataView(out.buffer).setUint32(0, header.length, true);
    out.set(header, 8);
    return out;
}

describe('FileUtils.detectViewerType signatures', () => {
    it('detects PDF files by signature even with a misleading extension', async () => {
        const file = makeFile(asciiBytes('%PDF-1.7\n'), 'mislabeled.jpg');
        const result = await FileUtils.detectViewerType(file, 'omni-viewer.imageViewer');
        expect(result.viewType).toBe('omni-viewer.pdfViewer');
        expect(result.matchedBySignature).toBe(true);
    });

    it('detects PNG files by signature', async () => {
        const file = makeFile([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 'mislabeled.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.imageViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('PNG');
    });

    it('detects JPEG files by signature', async () => {
        const file = makeFile([0xFF, 0xD8, 0xFF, 0xE0], 'photo.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.imageViewer');
        expect(result.reason).toContain('JPEG');
    });

    it('detects GIF87a/89a files by signature', async () => {
        const file = makeFile(asciiBytes('GIF89a___'), 'anim.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.imageViewer');
        expect(result.reason).toContain('GIF');
    });

    it('detects WEBP files by RIFF/WEBP container', async () => {
        const file = makeFile(
            concatBytes(asciiBytes('RIFF'), [0, 0, 0, 0], asciiBytes('WEBP'), [0, 0, 0, 0]),
            'image.bin'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.imageViewer');
        expect(result.reason).toContain('WebP');
    });

    it('detects BMP files by signature', async () => {
        const file = makeFile([0x42, 0x4D, 0x46, 0x00], 'bitmap.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.imageViewer');
        expect(result.reason).toContain('BMP');
    });

    it('detects PSD files by signature', async () => {
        const file = makeFile([0x38, 0x42, 0x50, 0x53, 0x00, 0x01], 'design.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.psdViewer');
        expect(result.reason).toContain('PSD');
    });

    it('detects NPY files by magic even with a misleading extension', async () => {
        const file = makeFile(
            [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x01, 0x00],
            'array.bin'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.numpyViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('NPY');
    });

    it('routes a ZIP signature with the .npz extension to NumPy', async () => {
        const file = makeFile([0x50, 0x4b, 0x03, 0x04, 0, 0], 'arrays.npz');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.numpyViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('NPZ');
    });

    it('keeps an HDF5 signature with the HDF5 viewer', async () => {
        const file = makeFile([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a], 'dataset.h5');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.hdf5Viewer');
        expect(result.matchedBySignature).toBe(true);
    });

    it('routes an HDF5 signature named .keras to the Keras viewer', async () => {
        // Keras 2 saved models are plain HDF5; the declared name is the only
        // thing that separates them from any other HDF5 file up front.
        const file = makeFile([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a], 'legacy.keras');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.kerasViewer');
        expect(result.matchedBySignature).toBe(true);
    });

    it('routes a ZIP signature with the .keras extension to the Keras viewer', async () => {
        const file = makeFile([0x50, 0x4b, 0x03, 0x04, 0, 0], 'mnist.keras');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.kerasViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('Keras');
    });

    it('uses the Keras extension fallback when the ZIP header is gone', async () => {
        const file = makeFile([0, 0, 0, 0], 'truncated.keras');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.kerasViewer');
        expect(result.matchedBySignature).toBe(false);
    });

    it('routes a ZIP signature with the .mlpackage extension to the Core ML viewer', async () => {
        const file = makeFile([0x50, 0x4b, 0x03, 0x04, 0, 0], 'resnet.mlpackage');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.coremlViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('Core ML');
    });

    it('uses the Core ML extension fallback for a bare .mlmodel protobuf', async () => {
        // Field 1 (specificationVersion) = 7 — a .mlmodel has no leading magic.
        const file = makeFile([0x08, 0x07, 0x12, 0x00], 'sentiment.mlmodel');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.coremlViewer');
        expect(result.matchedBySignature).toBe(false);
    });

    it('routes a safetensors header layout to the safetensors viewer', async () => {
        const file = makeFile(makeSafetensorsBytes(), 'weights.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.safetensorsViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('safetensors');
    });

    it('ignores a safetensors prefix whose header runs past the file', async () => {
        const bytes = makeSafetensorsBytes();
        // Claim a header far larger than the bytes that follow.
        new DataView(bytes.buffer).setUint32(0, 0xffff, true);
        const result = await FileUtils.detectViewerType(makeFile(bytes, 'mystery.bin'));
        expect(result.viewType).not.toBe('omni-viewer.safetensorsViewer');
    });

    it('uses the safetensors extension fallback when the header is gone', async () => {
        const result = await FileUtils.detectViewerType(makeFile([0, 0, 0, 0], 'truncated.safetensors'));
        expect(result.viewType).toBe('omni-viewer.safetensorsViewer');
        expect(result.matchedBySignature).toBe(false);
    });

    it.each(['truncated.npy', 'truncated.npz'])(
        'uses the NumPy extension fallback for %s',
        async (name) => {
            const result = await FileUtils.detectViewerType(makeFile([0], name));
            expect(result.viewType).toBe('omni-viewer.numpyViewer');
            expect(result.matchedBySignature).toBe(false);
        }
    );

    it('detects GGUF files by magic even with a misleading extension', async () => {
        const file = makeFile(asciiBytes('GGUF\x03\x00\x00\x00'), 'model.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.ggufViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('GGUF');
    });

    it('uses the GGUF extension fallback for a truncated file', async () => {
        const file = makeFile(asciiBytes('GGU'), 'truncated.gguf');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.ggufViewer');
        expect(result.matchedBySignature).toBe(false);
    });

    /**
     * ONNX is bare protobuf with no magic bytes, so detection is
     * extension-driven by design.
     */
    it('routes .onnx files to the ONNX viewer by extension', async () => {
        const file = makeFile([0x08, 0x07, 0x12, 0x04], 'model.onnx');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.onnxViewer');
        expect(result.matchedBySignature).toBe(false);
        expect(result.reason).toContain('ONNX');
    });

    it('detects TFLite models by the TFL3 identifier at byte offset 4', async () => {
        const file = makeFile(
            [0x14, 0, 0, 0, 0x54, 0x46, 0x4c, 0x33],
            'mislabeled.bin'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.tfliteViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('TFL3');
    });

    it('detects ExecuTorch programs by the ET12 identifier at byte offset 4', async () => {
        const file = makeFile(
            [0x14, 0, 0, 0, 0x45, 0x54, 0x31, 0x32],
            'mislabeled.bin'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.pteViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('ET12');
    });

    it('routes model.pte to the ExecuTorch viewer by extension', async () => {
        const result = await FileUtils.detectViewerType(makeFile('not a flatbuffer', 'model.pte'));
        expect(result.viewType).toBe('omni-viewer.pteViewer');
        expect(result.matchedBySignature).toBe(false);
    });

    it.each(['model.tflite', 'model.lite'])(
        'routes %s to the TFLite viewer by extension',
        async (name) => {
            const file = makeFile([0, 0, 0, 0], name);
            const result = await FileUtils.detectViewerType(file);
            expect(result.viewType).toBe('omni-viewer.tfliteViewer');
            expect(result.matchedBySignature).toBe(false);
        }
    );

    it('detects WAV files by RIFF/WAVE container', async () => {
        const file = makeFile(
            concatBytes(asciiBytes('RIFF'), [0, 0, 0, 0], asciiBytes('WAVE')),
            'audio.bin'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.audioViewer');
        expect(result.reason).toContain('WAV');
    });

    it('detects FLAC files by signature', async () => {
        const file = makeFile(asciiBytes('fLaC\x00\x00\x00\x22'), 'audio.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.audioViewer');
        expect(result.reason).toContain('FLAC');
    });

    it('detects MP3 files by ID3 header', async () => {
        const file = makeFile(asciiBytes('ID3\x04\x00'), 'audio.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.audioViewer');
        expect(result.reason).toContain('MP3');
    });

    it('detects OGG files by container signature', async () => {
        const file = makeFile(asciiBytes('OggS\x00\x02'), 'audio.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.audioViewer');
        expect(result.reason).toContain('OGG');
    });

    it('detects AIFF files by FORM signature', async () => {
        const file = makeFile(
            new Uint8Array([
                0x46, 0x4F, 0x52, 0x4D,
                0x00, 0x00, 0x00, 0x12,
                0x41, 0x49, 0x46, 0x46
            ]),
            'sample.bin'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.audioViewer');
        expect(result.reason).toContain('AIFF');
    });

    it('detects AMR files by header signature', async () => {
        const file = makeFile(asciiBytes('#!AMR\n'), 'voice.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.audioViewer');
        expect(result.reason).toContain('AMR');
    });

    it('detects MP4-family files as video by ftyp box', async () => {
        const file = makeFile(
            concatBytes([0x00, 0x00, 0x00, 0x18], asciiBytes('ftyp'), asciiBytes('isom\x00\x00\x00\x00')),
            'movie.bin'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.videoViewer');
        expect(result.reason).toContain('MP4');
    });

    it('routes m4a (audio MP4) to the audio viewer', async () => {
        const file = makeFile(
            concatBytes([0x00, 0x00, 0x00, 0x18], asciiBytes('ftyp'), asciiBytes('M4A \x00\x00\x00\x00')),
            'song.m4a'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.audioViewer');
    });

    it('detects AVI files by RIFF/AVI container', async () => {
        const file = makeFile(
            concatBytes(asciiBytes('RIFF'), [0, 0, 0, 0], asciiBytes('AVI ')),
            'movie.bin'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.videoViewer');
        expect(result.reason).toContain('AVI');
    });

    it('detects ZIP files as archive previews when they are not Office documents', async () => {
        const file = makeFile([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00], 'bundle.dat');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(true);
    });

    it('detects GZIP files by signature', async () => {
        const file = makeFile([0x1F, 0x8B, 0x08, 0x00], 'archive.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.reason).toContain('GZIP');
    });

    it('detects 7z files by signature', async () => {
        const file = makeFile([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C], 'archive.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.reason).toContain('7-Zip');
    });

    it('detects RAR v4 files by signature', async () => {
        const file = makeFile([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00], 'archive.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.reason).toContain('RAR v4');
    });

    it('detects RAR v5 files by signature', async () => {
        const file = makeFile([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00], 'archive.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.reason).toContain('RAR v5');
    });

    it('detects TAR files by ustar signature', async () => {
        const buf = new Uint8Array(512);
        const ustar = asciiBytes('ustar');
        buf.set(ustar, 257);
        const result = await FileUtils.detectViewerType(makeFile(buf, 'archive.bin'));
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.reason).toContain('TAR');
    });

    it('detects Parquet files by header and footer signatures', async () => {
        const buffer = concatBytes(
            asciiBytes('PAR1'),
            [0x00, 0x01, 0x02, 0x03],
            asciiBytes('PAR1')
        );
        const file = makeFile(buffer, 'sample.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.parquetViewer');
        expect(result.matchedBySignature).toBe(true);
    });

    it('routes DBC files to the automotive viewer by extension', async () => {
        const file = makeFile('BO_ 123 Engine: 8 ECU\n SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Vector__XXX\n', 'network.dbc');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.automotiveViewer');
        expect(result.matchedBySignature).toBe(false);
    });

    it('routes ARXML/A2L/ASC files to the automotive viewer by extension', async () => {
        const cases = [
            makeFile('<AUTOSAR><AR-PACKAGES /></AUTOSAR>', 'system.arxml'),
            makeFile('/begin MODULE ECU "demo"\n/end MODULE', 'calibration.a2l'),
            makeFile('date Mon Jan 1 00:00:00.000 2024\n0.000000 1 123x Rx d 8 00 01 02 03 04 05 06 07', 'trace.asc')
        ];
        for (const file of cases) {
            const result = await FileUtils.detectViewerType(file);
            expect(result.viewType).toBe('omni-viewer.automotiveViewer');
            expect(result.matchedBySignature).toBe(false);
        }
    });

    it('detects BLF files by LOGG signature', async () => {
        const file = makeFile(concatBytes(asciiBytes('LOGG'), [0x00, 0x00, 0x00, 0x00]), 'trace.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.automotiveViewer');
        expect(result.matchedBySignature).toBe(true);
    });

    it('detects MF4/MDF files by header signature', async () => {
        const file = makeFile(asciiBytes('MDF     4.10    '), 'measurement.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.automotiveViewer');
        expect(result.matchedBySignature).toBe(true);
    });

    it('detects Avro, ROS bag, and SQLite signatures', async () => {
        const cases: Array<[File, string]> = [
            [makeFile(new Uint8Array([79, 98, 106, 1, 0]), 'records.bin'), 'omni-viewer.avroViewer'],
            [makeFile(asciiBytes('#ROSBAG V2.0\n'), 'drive.bin'), 'omni-viewer.bagViewer'],
            [makeFile(asciiBytes('SQLite format 3\0'), 'rosbag.bin'), 'omni-viewer.db3Viewer'],
            [makeFile(new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1, 0, 0, 0, 0]), 'capture.bin'), 'omni-viewer.pcapViewer'],
            [makeFile(new Uint8Array([0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0]), 'capture.bin'), 'omni-viewer.pcapngViewer']
        ];
        for (const [file, viewType] of cases) {
            const result = await FileUtils.detectViewerType(file);
            expect(result.viewType).toBe(viewType);
            expect(result.matchedBySignature).toBe(true);
        }
    });

    it('routes Avro, BAG, STEP, DB3, ReqIF, and PCAP files by extension', async () => {
        const cases: Array<[File, string]> = [
            [makeFile(new Uint8Array([0]), 'records.avro'), 'omni-viewer.avroViewer'],
            [makeFile(new Uint8Array([0]), 'drive.bag'), 'omni-viewer.bagViewer'],
            [makeFile('ISO-10303-21;\nHEADER;\nENDSEC;', 'part.stp'), 'omni-viewer.stpViewer'],
            [makeFile(new Uint8Array([0]), 'rosbag.db3'), 'omni-viewer.db3Viewer'],
            [makeFile('<REQ-IF></REQ-IF>', 'requirements.reqif'), 'omni-viewer.reqifViewer'],
            [makeFile(new Uint8Array([0]), 'capture.pcap'), 'omni-viewer.pcapViewer'],
            [makeFile(new Uint8Array([0]), 'capture.pcapng'), 'omni-viewer.pcapngViewer']
        ];
        for (const [file, viewType] of cases) {
            const result = await FileUtils.detectViewerType(file);
            expect(result.viewType).toBe(viewType);
            expect(result.matchedBySignature).toBe(false);
        }
    });

    it('falls back to JSONL content sniffing for text files', async () => {
        const file = makeFile('{"id":1}\n{"id":2}\n', 'records.txt');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonlViewer');
        expect(result.matchedBySignature).toBe(false);
    });

    it('routes .har to the HAR viewer', async () => {
        const file = makeFile(
            '{"log":{"version":"1.2","creator":{"name":"WebInspector"},"entries":[]}}',
            'network.har'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.harViewer');
        expect(result.matchedBySignature).toBe(false);
        expect(result.reason).toContain('HAR extension');
    });

    it('claims a renamed HAR archive ahead of the JSON tree', async () => {
        const file = makeFile(
            '{\n  "log": {\n    "version": "1.2",\n'
            + '    "creator": { "name": "Firefox", "version": "131" },\n'
            + '    "entries": [\n      { "request": { "method": "GET" } }\n    ]\n  }\n}\n',
            'capture.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.harViewer');
        expect(result.reason).toContain('entries array');
    });

    it('claims a minified single-line archive', async () => {
        // What har-capturer, curl pipelines and any `JSON.stringify` of a
        // DevTools export produce. One line, so it reaches the HAR branch only
        // because `looksLikeJsonl` requires two.
        const file = makeFile(
            '{"log":{"version":"1.2","creator":{"name":"curl"},"entries":'
            + '[{"request":{"method":"GET","url":"https://api.example.test/v1/ping"}}]}}',
            'capture.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.harViewer');
    });

    it('claims a BOM-prefixed archive', async () => {
        // Fiddler and PowerShell-written captures carry a UTF-8 BOM; the
        // sample decoder strips it, so the opening `{` is still the first
        // character the sniff sees.
        const file = makeFile(
            concatBytes(
                [0xef, 0xbb, 0xbf],
                new TextEncoder().encode('{"log":{"version":"1.2","entries":[]}}')
            ),
            'capture.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.harViewer');
    });

    it('leaves a JSON document with an unrelated log field on the JSON viewer', async () => {
        const file = makeFile('{"log":{"level":"warn","message":"nope"}}', 'app.json');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonViewer');
    });

    it('does not claim an entries array that belongs to a sibling of log', async () => {
        // The `entries` member has to be the log object's own, as it is in the
        // core's structural `log.entries` lookup — a sibling further down the
        // document is not a HAR signal.
        const file = makeFile(
            '{"log":{"level":"warn"},"cache":{"entries":[{"key":"a"}]}}',
            'report.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonViewer');
    });

    it('does not claim a JSON document that merely wraps a capture', async () => {
        // A bug-report attachment: the archive sits under `har`, so `log` is
        // not the root's own member. The core routes this to the JSON tree and
        // `parseHar` would refuse it with `diag.har.missing-log`.
        const file = makeFile(
            '{"meta":{"ticket":"BUG-1"},"har":{"log":{"version":"1.2",'
            + '"entries":[{"request":{"method":"GET"}}]}}}',
            'attachment.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonViewer');
    });

    it('still claims an archive whose request bodies carry braces and quotes', async () => {
        // `postData.text` holds escaped JSON, so a brace counter that ignored
        // string literals would lose track of the log object's depth before
        // reaching `entries`.
        const file = makeFile(
            '{"log":{"version":"1.2","comment":"a \\"quoted\\" note {with braces}",'
            + '"creator":{"name":"WebInspector","comment":"}}}"},'
            + '"entries":[{"request":{"method":"POST","postData":'
            + '{"text":"{\\"amount\\":1200}"}}}]}}',
            'capture.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.harViewer');
    });

    it('routes .ipynb to the notebook viewer', async () => {
        const file = makeFile(
            '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}',
            'analysis.ipynb'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.notebookViewer');
        expect(result.matchedBySignature).toBe(false);
        expect(result.reason).toContain('Jupyter Notebook extension');
    });

    it('claims a renamed notebook whose nbformat falls past the head', async () => {
        // nbconvert and JupyterLab write `cells` first and `nbformat` last, so
        // in a notebook larger than the 64 KB head the only visible signals
        // are the `cells` array and the first `cell_type`.
        const file = makeFile(
            '{"cells":[{"cell_type":"code","execution_count":1,"source":["'
            + 'print(1)#'.repeat(8 * 1024)
            + '"],"outputs":[]}],"metadata":{},"nbformat":4,"nbformat_minor":5}',
            'export.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.notebookViewer');
        expect(result.reason).toContain('top-level notebook cells array');
    });

    it('leaves a complete JSON document with cells but no nbformat on the JSON viewer', async () => {
        // Nothing is truncated here, so `nbformat` — which every real notebook
        // carries — is genuinely absent: the core would refuse this with a
        // version error, where the JSON tree reads it.
        const file = makeFile(
            '{"cells":[{"cell_type":"code","source":["print(1)"]}],"metadata":{}}',
            'export.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonViewer');
    });

    it('does not take a cell_type outside the cells array as confirmation', async () => {
        // Past the 64 KB head, so the relaxed route is live; the `cell_type`
        // sits in a sibling object, and the search is scoped to `cells`.
        const file = makeFile(
            '{"cells":[{"id":1}],"schema":{"cell_type":"code","pad":"'
            + 'p'.repeat(70 * 1024)
            + '"}}',
            'schema.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonViewer');
    });

    it('claims a notebook whose nbformat precedes a long metadata block', async () => {
        // Colab and omni-viewer-core's own sample notebook write `nbformat`
        // first and `cells` last, so a big `metadata` block can push `cells`
        // past the 64 KB head — `nbformat` alone has to be enough.
        const file = makeFile(
            '{"nbformat":4,"nbformat_minor":0,"metadata":{"widgets":{"state":"'
            + 'w'.repeat(70 * 1024)
            + '"}},"cells":[{"cell_type":"code","source":["print(1)"]}]}',
            'colab-export.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.notebookViewer');
        expect(result.reason).toContain('nbformat');
    });

    it('claims a notebook that opens with a UTF-8 BOM', async () => {
        const file = makeFile(
            '\ufeff{"cells":[{"cell_type":"code","source":["print(1)"]}]'
            + ',"metadata":{},"nbformat":4,"nbformat_minor":5}',
            'bom.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.notebookViewer');
    });

    it('does not claim a JSON document that merely wraps a notebook', async () => {
        // A Jupyter Contents API response carries the notebook under
        // `content`. The core reads `nbformat`/`cells` off the parsed root, so
        // it would refuse this with a version error — the JSON tree reads it.
        const notebook = '{"cells":[{"cell_type":"code","source":["print(1)"]}]'
            + ',"metadata":{},"nbformat":4,"nbformat_minor":5}';
        const file = makeFile(
            `{"name":"Untitled.ipynb","type":"notebook","format":"json","content":${notebook}}`,
            'response.json'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonViewer');
    });

    it('leaves a line-delimited corpus of notebooks on the JSONL viewer', async () => {
        const record = '{"cells":[{"cell_type":"code","source":["print(1)"]}],"nbformat":4}';
        const file = makeFile(`${record}\n${record}\n`, 'notebooks.jsonl');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonlViewer');
    });

    it('leaves a JSON document with an unrelated cells field on the JSON viewer', async () => {
        const file = makeFile('{"cells":[{"id":1,"value":"a1"}]}', 'sheet.json');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonViewer');
    });

    it('detects JSON documents by extension', async () => {
        const file = makeFile('{"id":1,"name":"demo"}', 'sample.json');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonViewer');
        expect(result.matchedBySignature).toBe(false);
    });

    it('uses LaTeX viewer fallback for .tex, .latex and .ltx extensions', async () => {
        for (const name of ['paper.tex', 'paper.latex', 'paper.ltx']) {
            const file = makeFile(
                '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\n$E = mc^2$\n\\end{document}\n',
                name
            );
            const result = await FileUtils.detectViewerType(file);
            expect(result.viewType).toBe('omni-viewer.latexViewer');
            expect(result.reason).toContain('LaTeX extension');
        }
    });

    it('keeps .tex on the LaTeX viewer even when the body trips a text heuristic', async () => {
        // A .tex whose body would otherwise read as delimited text: the
        // explicit extension has to outrank the content sniffers.
        const file = makeFile(
            '\\documentclass{article}\n\\begin{document}\na,b,c\n1,2,3\n4,5,6\n\\end{document}\n',
            'table.tex'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.latexViewer');
    });

    it('routes an extensionless file with a \\documentclass preamble to the LaTeX viewer', async () => {
        const file = makeFile(
            '% Copyright someone\n% License: LPPL\n\\documentclass[11pt]{article}\n\\begin{document}\nHi\n\\end{document}\n',
            'thesis'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.latexViewer');
        expect(result.reason).toContain('documentclass');
    });

    it('does not re-route a named text file that merely mentions documentclass', async () => {
        const file = makeFile('key = "\\documentclass"\nother = 1\nthird = 2\n', 'notes.toml');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.tomlViewer');
    });

    it('uses Mermaid viewer fallback for .mmd extension', async () => {
        const file = makeFile('flowchart TD\n  A --> B\n', 'diagram.mmd');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.mermaidViewer');
        expect(result.reason).toContain('Mermaid extension');
    });

    it('detects Mermaid diagram syntax in text files', async () => {
        const file = makeFile('sequenceDiagram\n  Alice->>Bob: Hi\n', 'diagram.txt');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.mermaidViewer');
        expect(result.reason).toContain('Mermaid diagram syntax');
    });

    it('uses PlantUML viewer fallback for .puml extension', async () => {
        const file = makeFile('@startuml\nAlice -> Bob: Hi\n@enduml', 'diagram.puml');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.plantumlViewer');
        expect(result.reason).toContain('PlantUML extension');
    });

    it('detects PlantUML diagram syntax in text files', async () => {
        const file = makeFile('@startuml\nclass User\n@enduml', 'diagram.txt');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.plantumlViewer');
        expect(result.reason).toContain('PlantUML diagram syntax');
    });

    it('uses CSV viewer fallback for .csv extension', async () => {
        const file = makeFile('a,b,c\n1,2,3\n', 'data.csv');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.csvViewer');
    });

    it('uses CSV viewer for .tsv extension', async () => {
        const file = makeFile('name\trole\nAlice\tEng\n', 'data.tsv');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.csvViewer');
    });

    it('keeps .doc files on the Word viewer even when embedded workbook metadata exists', async () => {
        const header = new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
        const body = asciiBytes('WordDocument Workbook PowerPoint Document');
        const file = makeFile(concatBytes(header, body), 'embedded-chart.doc');
        const result = await FileUtils.detectViewerType(file, 'omni-viewer.wordViewer');
        expect(result.viewType).toBe('omni-viewer.wordViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('.doc');
    });

    it('keeps raw PCM files on the audio viewer instead of text sniffing', async () => {
        const file = makeFile(
            new Uint8Array([
                0x78, 0xff, 0x9b, 0xfe, 0x29, 0xfe, 0x9e, 0xff,
                0xc7, 0xff, 0x92, 0x00, 0x8c, 0x01, 0x48, 0x01,
                0x48, 0x01, 0x2a, 0x00, 0xee, 0x00, 0xea, 0xff
            ]),
            'sample.pcm'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.audioViewer');
        expect(result.matchedBySignature).toBe(false);
        expect(result.reason).toContain('raw audio extension fallback');
    });

    it('falls back to the archive viewer for DMG files by extension', async () => {
        const file = makeFile(asciiBytes('not-a-real-dmg'), 'disk.dmg');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(false);
        expect(result.reason).toContain('archive extension fallback');
    });

    it('returns null viewer type and a reason when nothing matches', async () => {
        const file = makeFile(new Uint8Array([0x00, 0x01, 0x02, 0x03]), 'mystery.unknown');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBeNull();
        expect(result.matchedBySignature).toBe(false);
    });

    it('honors a fallback view type when no signature matches', async () => {
        const file = makeFile(new Uint8Array([0x00, 0x01, 0x02, 0x03]), 'mystery.unknown');
        const result = await FileUtils.detectViewerType(file, 'omni-viewer.imageViewer');
        expect(result.viewType).toBe('omni-viewer.imageViewer');
        expect(result.matchedBySignature).toBe(false);
        expect(result.reason).toContain('extension fallback');
    });
});

describe('FileUtils.detectViewerType OOXML / HWPX disambiguation', () => {
    function makeOoxmlZipBytes(filename: string): Uint8Array {
        // Build a single-entry ZIP local file header naming `filename`.
        const nameBytes = asciiBytes(filename);
        const header = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);  // local file header signature
        view.setUint16(4, 20, true);           // version needed
        view.setUint16(6, 0, true);            // general purpose flags (no streaming descriptor)
        view.setUint16(8, 0, true);            // compression method (stored)
        view.setUint16(10, 0, true);           // mod time
        view.setUint16(12, 0, true);           // mod date
        view.setUint32(14, 0, true);           // crc
        view.setUint32(18, 0, true);           // compressed size
        view.setUint32(22, 0, true);           // uncompressed size
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true);           // extra field length
        header.set(nameBytes, 30);
        return header;
    }

    it('routes a ZIP container with word/ entries to the Word viewer', async () => {
        const file = makeFile(makeOoxmlZipBytes('word/document.xml'), 'doc.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.wordViewer');
        expect(result.reason).toContain('Word OOXML');
    });

    it('routes a ZIP container with xl/ entries to the Excel viewer', async () => {
        const file = makeFile(makeOoxmlZipBytes('xl/workbook.xml'), 'sheet.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.excelViewer');
    });

    it('routes a ZIP container with ppt/ entries to the PowerPoint viewer', async () => {
        const file = makeFile(makeOoxmlZipBytes('ppt/presentation.xml'), 'deck.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.pptViewer');
    });

    it('routes a ZIP container with Contents/content.hpf to the HWP viewer', async () => {
        const file = makeFile(makeOoxmlZipBytes('Contents/content.hpf'), 'doc.bin');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.hwpViewer');
    });

    it('routes a ZIP container with Keras model entries to the Keras viewer', async () => {
        const file = makeFile(
            concatBytes(
                makeOoxmlZipBytes('config.json'),
                makeOoxmlZipBytes('model.weights.h5')
            ),
            'model.bin'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.kerasViewer');
        expect(result.reason).toContain('Keras');
    });

    it('routes a ZIP container with Core ML package entries to the Core ML viewer', async () => {
        const file = makeFile(
            concatBytes(
                makeOoxmlZipBytes('Resnet.mlpackage/Manifest.json'),
                makeOoxmlZipBytes('Resnet.mlpackage/Data/com.apple.CoreML/model.mlmodel')
            ),
            'model.bin'
        );
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.coremlViewer');
        expect(result.reason).toContain('Core ML');
    });

    describe('OpenVINO IR', () => {
        const IR = '<?xml version="1.0"?>\n<!-- exported -->\n<net name="tiny" version="11">\n<layers>\n<layer id="0" name="a,b,c" type="Parameter" version="opset1"/>\n</layers>\n<edges/>\n</net>';

        it('routes an IR .xml to the OpenVINO viewer by content', async () => {
            const result = await FileUtils.detectViewerType(makeFile(IR, 'tiny.xml'));
            expect(result.viewType).toBe('omni-viewer.openvinoViewer');
            expect(result.matchedBySignature).toBe(false);
        });

        it('routes an extensionless IR the same way', async () => {
            const result = await FileUtils.detectViewerType(makeFile(IR, 'tiny'));
            expect(result.viewType).toBe('omni-viewer.openvinoViewer');
        });

        it('reads past a BOM and a DOCTYPE', async () => {
            const result = await FileUtils.detectViewerType(
                makeFile('\ufeff<!DOCTYPE net><net version="10"><layers/></net>', 'legacy.xml')
            );
            expect(result.viewType).toBe('omni-viewer.openvinoViewer');
        });

        it('does not claim a <net> root without a numeric version or <layers>', async () => {
            const noVersion = await FileUtils.detectViewerType(makeFile('<net name="x"><layers/></net>', 'a.xml'));
            expect(noVersion.viewType).not.toBe('omni-viewer.openvinoViewer');
            const noLayers = await FileUtils.detectViewerType(makeFile('<net version="11"><nodes/></net>', 'b.xml'));
            expect(noLayers.viewType).not.toBe('omni-viewer.openvinoViewer');
            const upperCase = await FileUtils.detectViewerType(makeFile('<NET version="11"><LAYERS/></NET>', 'c.xml'));
            expect(upperCase.viewType).not.toBe('omni-viewer.openvinoViewer');
        });

        it('leaves other XML documents alone', async () => {
            const result = await FileUtils.detectViewerType(
                makeFile('<?xml version="1.0"?><AUTOSAR><layers/></AUTOSAR>', 'system.xml')
            );
            expect(result.viewType).not.toBe('omni-viewer.openvinoViewer');
        });

        it('maps the view type to its short name', () => {
            expect(shortNameForViewType('omni-viewer.openvinoViewer')).toBe('openvino');
        });
    });

    it('leaves a ZIP holding only Manifest.json with the archive viewer', async () => {
        const file = makeFile(makeOoxmlZipBytes('Manifest.json'), 'bundle.zip');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
    });

    it('leaves a ZIP holding only config.json with the archive viewer', async () => {
        const file = makeFile(makeOoxmlZipBytes('config.json'), 'settings.zip');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
    });

    it('respects an injected JSZip-like instance over the manual parser', async () => {
        // Manual parser would see only "word/..."; the injected JSZip yields "ppt/...".
        const file = makeFile(makeOoxmlZipBytes('word/document.xml'), 'doc.bin');
        const fakeJsZip = {
            loadAsync: jest.fn().mockResolvedValue({
                files: { 'ppt/presentation.xml': {} }
            })
        };
        const result = await FileUtils.detectViewerType(file, { jsZip: fakeJsZip });
        expect(result.viewType).toBe('omni-viewer.pptViewer');
        expect(fakeJsZip.loadAsync).toHaveBeenCalledTimes(1);
    });
});

describe('FileUtils MIME helpers', () => {
    it('returns MIME types for AIFF and AC3 extensions', () => {
        expect(FileUtils.getAudioMimeType('track.aiff')).toBe('audio/aiff');
        expect(FileUtils.getAudioMimeType('track.aif')).toBe('audio/aiff');
        expect(FileUtils.getAudioMimeType('track.aifc')).toBe('audio/aiff');
        expect(FileUtils.getAudioMimeType('track.ac3')).toBe('audio/ac3');
        expect(FileUtils.getAudioMimeType('voice.pcm')).toBe('audio/wav');
    });

    it('returns MIME types for AMR and MPEG transport stream extensions', () => {
        expect(FileUtils.getAudioMimeType('voice.amr')).toBe('audio/amr');
        expect(FileUtils.getAudioMimeType('voice.awb')).toBe('audio/amr-wb');
        expect(FileUtils.getVideoMimeType('clip.ts')).toBe('video/mp2t');
        expect(FileUtils.getVideoMimeType('clip.mts')).toBe('video/mp2t');
        expect(FileUtils.getVideoMimeType('clip.m2ts')).toBe('video/mp2t');
    });

    it('returns image MIME types for common extensions', () => {
        expect(FileUtils.getImageMimeType('a.png')).toBe('image/png');
        expect(FileUtils.getImageMimeType('a.svg')).toBe('image/svg+xml');
    });
});

describe('FileUtils audio metadata', () => {
    it('reports default metadata for raw PCM files', async () => {
        const file = new File([new Uint8Array(32000)], 'voice.pcm');
        const metadata = await FileUtils.getAudioMetadata(file);
        expect(metadata.sampleRate).toBe(16000);
        expect(metadata.channels).toBe(1);
        expect(metadata.bitDepth).toBe(16);
        expect(metadata.duration).toBe(1);
        expect(metadata.format).toBe('PCM (s16le)');
    });
});

describe('shortNameForViewType', () => {
    it('maps view types to the legacy short identifiers used by app.js', () => {
        expect(shortNameForViewType('omni-viewer.imageViewer')).toBe('image');
        expect(shortNameForViewType('omni-viewer.audioViewer')).toBe('audio');
        expect(shortNameForViewType('omni-viewer.archiveViewer')).toBe('archive');
        expect(shortNameForViewType('omni-viewer.parquetViewer')).toBe('parquet');
        expect(shortNameForViewType('omni-viewer.numpyViewer')).toBe('numpy');
        expect(shortNameForViewType('omni-viewer.mermaidViewer')).toBe('mermaid');
        expect(shortNameForViewType('omni-viewer.markdownViewer')).toBe('markdown');
        expect(shortNameForViewType('omni-viewer.notebookViewer')).toBe('notebook');
        expect(shortNameForViewType('omni-viewer.latexViewer')).toBe('latex');
        expect(shortNameForViewType('omni-viewer.plantumlViewer')).toBe('plantuml');
        expect(shortNameForViewType('omni-viewer.harViewer')).toBe('har');
        expect(shortNameForViewType('omni-viewer.avroViewer')).toBe('automotive');
        expect(shortNameForViewType('omni-viewer.reqifViewer')).toBe('automotive');
    });
});
