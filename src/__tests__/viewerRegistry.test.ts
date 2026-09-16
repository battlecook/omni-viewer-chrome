// runs after #7 sets up jest
//
// Unit assertions for `viewerRegistry`. These tests intentionally only depend
// on `describe` / `it` / `expect` — once issue #7 wires up jest + ts-jest the
// suite should pass without modification.
//
// Why this file exists in advance: issue #2 states "viewerRegistry 단위
// 테스트 (mapping)". We capture the expected mapping now so the contract is
// version-controlled and a regression in #7 (or any later registry edit) is
// caught the moment jest is enabled.
//
// Run skip note: `npm run build` does NOT typecheck this file at runtime
// (the webpack entries don't pull it in), but TypeScript itself does — see
// the `// @ts-ignore` guards below for the `describe` / `it` / `expect`
// globals that are not in scope until jest's types are installed.

// The jest globals are not present in the current toolchain, but TypeScript
// is configured with `skipLibCheck` and the test file is excluded from the
// webpack entry graph, so the ambient declarations below are sufficient to
// keep `tsc --noEmit` (and ts-loader's `transpileOnly` build) green.

declare const describe: (name: string, body: () => void) => void;
declare const it: (name: string, body: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
    toBe: (expected: unknown) => void;
    toEqual: (expected: unknown) => void;
    toBeUndefined: () => void;
    toBeDefined: () => void;
    toHaveLength: (n: number) => void;
};

import {
    VIEWER_REGISTRATIONS,
    getRegistrationByViewType,
    getRegistrationBySlug,
    resolveRegistrationByFileName,
    OmniViewerViewType,
    ViewerSlug
} from '../viewerRegistry';

const ALL_SLUGS: ViewerSlug[] = [
    'image',
    'pdf',
    'audio',
    'video',
    'csv',
    'excel',
    'parquet',
    'numpy',
    'gguf',
    'onnx',
    'tflite',
    'keras',
    'coreml',
    'openvino',
    'safetensors',
    'word',
    'ppt',
    'psd',
    'hwp',
    'archive',
    'json',
    'jsonl',
    'yaml',
    'toml',
    'markdown',
    'latex',
    'mermaid',
    'plantuml',
    'proto',
    'automotive',
    'avro',
    'bag',
    'stp',
    'db3',
    'reqif',
    'pcap',
    'pcapng',
    'mat',
    'hdf5'
];

describe('viewerRegistry', () => {
    it('registers all viewers', () => {
        expect(VIEWER_REGISTRATIONS).toHaveLength(39);
        const slugs = VIEWER_REGISTRATIONS.map((r) => r.slug).sort();
        expect(slugs).toEqual([...ALL_SLUGS].sort());
    });

    it('uses unique viewType identifiers', () => {
        const seen = new Set<string>();
        for (const r of VIEWER_REGISTRATIONS) {
            expect(seen.has(r.viewType)).toBe(false);
            seen.add(r.viewType);
        }
    });

    it('uses unique command identifiers', () => {
        const seen = new Set<string>();
        for (const r of VIEWER_REGISTRATIONS) {
            expect(seen.has(r.command)).toBe(false);
            seen.add(r.command);
        }
    });

    it('keeps viewType <-> slug mapping consistent', () => {
        for (const r of VIEWER_REGISTRATIONS) {
            const expected: OmniViewerViewType =
                `omni-viewer.${r.slug}Viewer` as OmniViewerViewType;
            expect(r.viewType).toBe(expected);
        }
    });

    it('mirrors VSCode `retainContextWhenHidden` semantics for pdf', () => {
        const pdf = getRegistrationBySlug('pdf');
        expect(pdf).toBeDefined();
        expect(pdf?.retainContextWhenHidden).toBe(false);
    });

    it('marks every other viewer as retainContextWhenHidden=true', () => {
        for (const r of VIEWER_REGISTRATIONS) {
            if (r.slug === 'pdf') continue;
            expect(r.retainContextWhenHidden).toBe(true);
        }
    });

    it('looks up by viewType', () => {
        const r = getRegistrationByViewType('omni-viewer.imageViewer');
        expect(r?.slug).toBe('image');
    });

    it('looks up by slug', () => {
        const r = getRegistrationBySlug('archive');
        expect(r?.viewType).toBe('omni-viewer.archiveViewer');
    });

    describe('resolveRegistrationByFileName', () => {
        const cases: Array<[string, ViewerSlug | undefined]> = [
            ['photo.png', 'image'],
            ['Photo.JPG', 'image'],
            ['report.pdf', 'pdf'],
            ['data.csv', 'csv'],
            ['data.tsv', 'csv'],
            ['log.jsonl', 'jsonl'],
            ['log.ndjson', 'jsonl'],
            ['config.yaml', 'yaml'],
            ['config.yml', 'yaml'],
            ['Cargo.toml', 'toml'],
            ['README.md', 'markdown'],
            ['notes.markdown', 'markdown'],
            ['paper.tex', 'latex'],
            ['paper.latex', 'latex'],
            ['paper.ltx', 'latex'],
            ['diagram.mmd', 'mermaid'],
            ['diagram.mermaid', 'mermaid'],
            ['diagram.puml', 'plantuml'],
            ['diagram.plantuml', 'plantuml'],
            ['schema.proto', 'proto'],
            ['network.dbc', 'automotive'],
            ['system.arxml', 'automotive'],
            ['calibration.a2l', 'automotive'],
            ['trace.asc', 'automotive'],
            ['trace.blf', 'automotive'],
            ['measurement.mf4', 'automotive'],
            ['records.avro', 'avro'],
            ['drive.bag', 'bag'],
            ['part.stp', 'stp'],
            ['part.step', 'stp'],
            ['rosbag.db3', 'db3'],
            ['requirements.reqif', 'reqif'],
            ['capture.pcap', 'pcap'],
            ['capture.pcapng', 'pcapng'],
            ['workspace.mat', 'mat'],
            ['dataset.h5', 'hdf5'],
            ['dataset.hdf5', 'hdf5'],
            ['song.mp3', 'audio'],
            ['voice.pcm', 'audio'],
            ['movie.mp4', 'video'],
            ['book.docx', 'word'],
            ['deck.pptx', 'ppt'],
            ['layered.psd', 'psd'],
            ['data.parquet', 'parquet'],
            ['array.npy', 'numpy'],
            ['arrays.npz', 'numpy'],
            ['model.gguf', 'gguf'],
            ['model.onnx', 'onnx'],
            ['model.tflite', 'tflite'],
            ['model.lite', 'tflite'],
            ['model.keras', 'keras'],
            ['model.mlmodel', 'coreml'],
            ['model.mlpackage', 'coreml'],
            // OpenVINO IR is routed by content, never by its shared `.xml`.
            ['model.xml', undefined],
            ['model.safetensors', 'safetensors'],
            ['report.hwpx', 'hwp'],
            ['archive.zip', 'archive'],
            ['archive.tar.gz', 'archive'],
            ['no-extension', undefined],
            ['mystery.xyz', undefined]
        ];

        for (const [name, expectedSlug] of cases) {
            it(`resolves ${name} -> ${expectedSlug ?? 'undefined'}`, () => {
                const r = resolveRegistrationByFileName(name);
                if (expectedSlug === undefined) {
                    expect(r).toBeUndefined();
                } else {
                    expect(r?.slug).toBe(expectedSlug);
                }
            });
        }
    });

    it('createProvider produces a render function', () => {
        for (const r of VIEWER_REGISTRATIONS) {
            const provider = r.createProvider();
            expect(typeof provider.render).toBe('function');
        }
    });
});
