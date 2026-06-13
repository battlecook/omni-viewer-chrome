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

    it('falls back to JSONL content sniffing for text files', async () => {
        const file = makeFile('{"id":1}\n{"id":2}\n', 'records.txt');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonlViewer');
        expect(result.matchedBySignature).toBe(false);
    });

    it('detects JSON documents by extension', async () => {
        const file = makeFile('{"id":1,"name":"demo"}', 'sample.json');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.jsonViewer');
        expect(result.matchedBySignature).toBe(false);
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
        expect(shortNameForViewType('omni-viewer.mermaidViewer')).toBe('mermaid');
        expect(shortNameForViewType('omni-viewer.markdownViewer')).toBe('markdown');
        expect(shortNameForViewType('omni-viewer.plantumlViewer')).toBe('plantuml');
    });
});
