// Chrome-flavored port of the VSCode `viewerRegistry.ts` module.
//
// Each entry mirrors the VSCode original (viewType, command, missingMessage,
// retainContextWhenHidden, createProvider) so a future split between the two
// codebases stays diff-friendly. The differences are:
//
//   - `createProvider` no longer takes `vscode.ExtensionContext`. The Chrome
//     page just needs a File-handle-driven render call, so the factory is
//     parameterless and produces a `ChromeViewerProvider`.
//   - `command` is kept as a stable string identifier that mirrors the VSCode
//     command palette IDs. It is currently informational on the Chrome side
//     (no command palette), but downstream issues (#5 context menus,
//     "Open with…" right-click integration) will key off it.
//   - `retainContextWhenHidden` has no Chrome equivalent. It is preserved as
//     metadata so the value can drive future page-cache decisions; for now
//     the router ignores it.
//
// The actual per-viewer providers will be filled in by later issues. Until
// then every entry resolves to a placeholder provider that renders an
// "implementation pending" notice. That keeps the routing layer testable now
// while leaving the per-viewer logic to its own dedicated issue.

import {
    ChromeViewerProvider,
    renderUnsupported
} from './viewerProviderUtils';

/**
 * Stable view-type identifiers. These are the same strings the VSCode
 * extension uses (`omni-viewer.<viewer>Viewer`) so the registry shape stays
 * one-to-one with `vscode-omni-viewer/src/utils/fileUtils.ts`.
 */
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
    | 'omni-viewer.protoViewer'
    | 'omni-viewer.automotiveViewer'
    | 'omni-viewer.avroViewer'
    | 'omni-viewer.bagViewer'
    | 'omni-viewer.stpViewer'
    | 'omni-viewer.db3Viewer'
    | 'omni-viewer.reqifViewer'
    | 'omni-viewer.pcapViewer'
    | 'omni-viewer.pcapngViewer'
    | 'omni-viewer.matViewer'
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

/**
 * The short slug used in URLs and the `templates/<slug>/` directory layout.
 * Mapped from the full `omni-viewer.*Viewer` viewType.
 */
export type ViewerSlug =
    | 'audio'
    | 'video'
    | 'image'
    | 'archive'
    | 'csv'
    | 'json'
    | 'yaml'
    | 'jsonl'
    | 'toml'
    | 'markdown'
    | 'latex'
    | 'mermaid'
    | 'plantuml'
    | 'proto'
    | 'automotive'
    | 'avro'
    | 'bag'
    | 'stp'
    | 'db3'
    | 'reqif'
    | 'pcap'
    | 'pcapng'
    | 'mat'
    | 'hdf5'
    | 'numpy'
    | 'gguf'
    | 'onnx'
    | 'tflite'
    | 'keras'
    | 'coreml'
    | 'openvino'
    | 'safetensors'
    | 'parquet'
    | 'hwp'
    | 'psd'
    | 'excel'
    | 'word'
    | 'pdf'
    | 'ppt';

export interface ViewerRegistration {
    viewType: OmniViewerViewType;
    slug: ViewerSlug;
    command: string;
    missingMessage: string;
    retainContextWhenHidden: boolean;
    createProvider: () => ChromeViewerProvider;
}

/**
 * Default placeholder provider used by every entry until per-viewer logic
 * lands in subsequent issues. It renders a neutral "this viewer is wired up
 * but not implemented yet" notice into the host container so the routing
 * layer is end-to-end testable.
 */
function createPlaceholderProvider(viewType: OmniViewerViewType): ChromeViewerProvider {
    return {
        render(file: File, container: HTMLElement): void {
            renderUnsupported(container, file.name, `viewType=${viewType}`, {
                title: 'Viewer not yet implemented',
                message:
                    'The routing layer matched this viewer, but the renderer ' +
                    'will be ported in a follow-up issue.',
                icon: '*'
            });
        }
    };
}

export const VIEWER_REGISTRATIONS: ViewerRegistration[] = [
    {
        viewType: 'omni-viewer.archiveViewer',
        slug: 'archive',
        command: 'omni-viewer.openArchiveViewer',
        missingMessage: 'No archive file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.archiveViewer')
    },
    {
        viewType: 'omni-viewer.audioViewer',
        slug: 'audio',
        command: 'omni-viewer.openAudioViewer',
        missingMessage: 'No audio file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.audioViewer')
    },
    {
        viewType: 'omni-viewer.imageViewer',
        slug: 'image',
        command: 'omni-viewer.openImageViewer',
        missingMessage: 'No image file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.imageViewer')
    },
    {
        viewType: 'omni-viewer.videoViewer',
        slug: 'video',
        command: 'omni-viewer.openVideoViewer',
        missingMessage: 'No video file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.videoViewer')
    },
    {
        viewType: 'omni-viewer.csvViewer',
        slug: 'csv',
        command: 'omni-viewer.openCsvViewer',
        missingMessage: 'No CSV file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.csvViewer')
    },
    {
        viewType: 'omni-viewer.jsonViewer',
        slug: 'json',
        command: 'omni-viewer.openJsonViewer',
        missingMessage: 'No JSON file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.jsonViewer')
    },
    {
        viewType: 'omni-viewer.yamlViewer',
        slug: 'yaml',
        command: 'omni-viewer.openYamlViewer',
        missingMessage: 'No YAML file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.yamlViewer')
    },
    {
        viewType: 'omni-viewer.jsonlViewer',
        slug: 'jsonl',
        command: 'omni-viewer.openJsonlViewer',
        missingMessage: 'No JSONL file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.jsonlViewer')
    },
    {
        viewType: 'omni-viewer.tomlViewer',
        slug: 'toml',
        command: 'omni-viewer.openTomlViewer',
        missingMessage: 'No TOML file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.tomlViewer')
    },
    {
        viewType: 'omni-viewer.markdownViewer',
        slug: 'markdown',
        command: 'omni-viewer.openMarkdownViewer',
        missingMessage: 'No Markdown file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.markdownViewer')
    },
    {
        viewType: 'omni-viewer.latexViewer',
        slug: 'latex',
        command: 'omni-viewer.openLatexViewer',
        missingMessage: 'No LaTeX file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.latexViewer')
    },
    {
        viewType: 'omni-viewer.mermaidViewer',
        slug: 'mermaid',
        command: 'omni-viewer.openMermaidViewer',
        missingMessage: 'No Mermaid file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.mermaidViewer')
    },
    {
        viewType: 'omni-viewer.plantumlViewer',
        slug: 'plantuml',
        command: 'omni-viewer.openPlantUmlViewer',
        missingMessage: 'No PlantUML file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.plantumlViewer')
    },
    {
        viewType: 'omni-viewer.protoViewer',
        slug: 'proto',
        command: 'omni-viewer.openProtoViewer',
        missingMessage: 'No Protocol Buffers schema selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.protoViewer')
    },
    {
        viewType: 'omni-viewer.automotiveViewer',
        slug: 'automotive',
        command: 'omni-viewer.openAutomotiveViewer',
        missingMessage: 'No automotive data file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.automotiveViewer')
    },
    {
        viewType: 'omni-viewer.avroViewer',
        slug: 'avro',
        command: 'omni-viewer.openAvroViewer',
        missingMessage: 'No Avro file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.avroViewer')
    },
    {
        viewType: 'omni-viewer.bagViewer',
        slug: 'bag',
        command: 'omni-viewer.openBagViewer',
        missingMessage: 'No BAG file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.bagViewer')
    },
    {
        viewType: 'omni-viewer.stpViewer',
        slug: 'stp',
        command: 'omni-viewer.openStpViewer',
        missingMessage: 'No STEP file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.stpViewer')
    },
    {
        viewType: 'omni-viewer.db3Viewer',
        slug: 'db3',
        command: 'omni-viewer.openDb3Viewer',
        missingMessage: 'No DB3 file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.db3Viewer')
    },
    {
        viewType: 'omni-viewer.reqifViewer',
        slug: 'reqif',
        command: 'omni-viewer.openReqifViewer',
        missingMessage: 'No ReqIF file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.reqifViewer')
    },
    {
        viewType: 'omni-viewer.pcapViewer',
        slug: 'pcap',
        command: 'omni-viewer.openPcapViewer',
        missingMessage: 'No PCAP file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.pcapViewer')
    },
    {
        viewType: 'omni-viewer.pcapngViewer',
        slug: 'pcapng',
        command: 'omni-viewer.openPcapngViewer',
        missingMessage: 'No PCAPNG file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.pcapngViewer')
    },
    {
        viewType: 'omni-viewer.matViewer',
        slug: 'mat',
        command: 'omni-viewer.openMatViewer',
        missingMessage: 'No MAT file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.matViewer')
    },
    {
        viewType: 'omni-viewer.hdf5Viewer',
        slug: 'hdf5',
        command: 'omni-viewer.openHdf5Viewer',
        missingMessage: 'No HDF5 file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.hdf5Viewer')
    },
    {
        viewType: 'omni-viewer.numpyViewer',
        slug: 'numpy',
        command: 'omni-viewer.openNumpyViewer',
        missingMessage: 'No NumPy file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.numpyViewer')
    },
    {
        viewType: 'omni-viewer.ggufViewer',
        slug: 'gguf',
        command: 'omni-viewer.openGgufViewer',
        missingMessage: 'No GGUF file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.ggufViewer')
    },
    {
        viewType: 'omni-viewer.onnxViewer',
        slug: 'onnx',
        command: 'omni-viewer.openOnnxViewer',
        missingMessage: 'No ONNX file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.onnxViewer')
    },
    {
        viewType: 'omni-viewer.tfliteViewer',
        slug: 'tflite',
        command: 'omni-viewer.openTfliteViewer',
        missingMessage: 'No TFLite file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.tfliteViewer')
    },
    {
        viewType: 'omni-viewer.kerasViewer',
        slug: 'keras',
        command: 'omni-viewer.openKerasViewer',
        missingMessage: 'No Keras file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.kerasViewer')
    },
    {
        viewType: 'omni-viewer.coremlViewer',
        slug: 'coreml',
        command: 'omni-viewer.openCoremlViewer',
        missingMessage: 'No Core ML file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.coremlViewer')
    },
    {
        viewType: 'omni-viewer.openvinoViewer',
        slug: 'openvino',
        command: 'omni-viewer.openOpenVinoViewer',
        missingMessage: 'No OpenVINO IR file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.openvinoViewer')
    },
    {
        viewType: 'omni-viewer.safetensorsViewer',
        slug: 'safetensors',
        command: 'omni-viewer.openSafetensorsViewer',
        missingMessage: 'No safetensors file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.safetensorsViewer')
    },
    {
        viewType: 'omni-viewer.parquetViewer',
        slug: 'parquet',
        command: 'omni-viewer.openParquetViewer',
        missingMessage: 'No Parquet file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.parquetViewer')
    },
    {
        viewType: 'omni-viewer.hwpViewer',
        slug: 'hwp',
        command: 'omni-viewer.openHwpViewer',
        missingMessage: 'No HWP file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.hwpViewer')
    },
    {
        viewType: 'omni-viewer.psdViewer',
        slug: 'psd',
        command: 'omni-viewer.openPsdViewer',
        missingMessage: 'No PSD file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.psdViewer')
    },
    {
        viewType: 'omni-viewer.excelViewer',
        slug: 'excel',
        command: 'omni-viewer.openExcelViewer',
        missingMessage: 'No Excel file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.excelViewer')
    },
    {
        viewType: 'omni-viewer.wordViewer',
        slug: 'word',
        command: 'omni-viewer.openWordViewer',
        missingMessage: 'No Word file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.wordViewer')
    },
    {
        viewType: 'omni-viewer.pdfViewer',
        slug: 'pdf',
        command: 'omni-viewer.openPdfViewer',
        missingMessage: 'No PDF file selected',
        retainContextWhenHidden: false,
        createProvider: () => createPlaceholderProvider('omni-viewer.pdfViewer')
    },
    {
        viewType: 'omni-viewer.pptViewer',
        slug: 'ppt',
        command: 'omni-viewer.openPptViewer',
        missingMessage: 'No PowerPoint file selected',
        retainContextWhenHidden: true,
        createProvider: () => createPlaceholderProvider('omni-viewer.pptViewer')
    }
];

/**
 * Lookup helpers. These do not duplicate state — they are pure derivations
 * over `VIEWER_REGISTRATIONS`, which is the single source of truth.
 */

export function getRegistrationByViewType(
    viewType: OmniViewerViewType
): ViewerRegistration | undefined {
    return VIEWER_REGISTRATIONS.find((r) => r.viewType === viewType);
}

export function getRegistrationBySlug(slug: ViewerSlug): ViewerRegistration | undefined {
    return VIEWER_REGISTRATIONS.find((r) => r.slug === slug);
}

/**
 * Mapping of common file extensions to a registry slug. This is intentionally
 * a small, pragmatic subset that mirrors the legacy `formats` table in
 * `src/app.js`; the authoritative byte-signature detection from
 * `vscode-omni-viewer/src/utils/fileUtils.ts` will be ported in a later issue.
 */
const EXTENSION_TO_SLUG: Record<string, ViewerSlug> = {
    '.jpg': 'image',
    '.jpeg': 'image',
    '.png': 'image',
    '.gif': 'image',
    '.bmp': 'image',
    '.webp': 'image',
    '.svg': 'image',
    '.pdf': 'pdf',
    '.csv': 'csv',
    '.tsv': 'csv',
    '.json': 'json',
    '.jsonl': 'jsonl',
    '.ndjson': 'jsonl',
    '.jsonlines': 'jsonl',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.tex': 'latex',
    '.latex': 'latex',
    '.ltx': 'latex',
    '.mmd': 'mermaid',
    '.mermaid': 'mermaid',
    '.puml': 'plantuml',
    '.plantuml': 'plantuml',
    '.iuml': 'plantuml',
    '.proto': 'proto',
    '.dbc': 'automotive',
    '.arxml': 'automotive',
    '.a2l': 'automotive',
    '.asc': 'automotive',
    '.blf': 'automotive',
    '.mf4': 'automotive',
    '.mdf': 'automotive',
    '.avro': 'avro',
    '.bag': 'bag',
    '.stp': 'stp',
    '.step': 'stp',
    '.db3': 'db3',
    '.sqlite': 'db3',
    '.sqlite3': 'db3',
    '.reqif': 'reqif',
    '.pcap': 'pcap',
    '.pcapng': 'pcapng',
    '.mat': 'mat',
    '.h5': 'hdf5',
    '.hdf5': 'hdf5',
    '.npy': 'numpy',
    '.npz': 'numpy',
    '.gguf': 'gguf',
    '.onnx': 'onnx',
    '.tflite': 'tflite',
    '.lite': 'tflite',
    '.keras': 'keras',
    '.mlmodel': 'coreml',
    '.mlpackage': 'coreml',
    // OpenVINO IR is deliberately absent: its `.xml` is shared with every
    // other XML dialect, so it is routed by content (`<net version>` with
    // `<layers>`) in `FileUtils.detectViewerType` / app.js `detectType` only.
    '.safetensors': 'safetensors',
    '.mp3': 'audio',
    '.wav': 'audio',
    '.ogg': 'audio',
    '.flac': 'audio',
    '.aac': 'audio',
    '.m4a': 'audio',
    '.pcm': 'audio',
    '.mp4': 'video',
    '.webm': 'video',
    '.mov': 'video',
    '.m4v': 'video',
    '.ogv': 'video',
    '.xlsx': 'excel',
    '.xls': 'excel',
    '.docx': 'word',
    '.doc': 'word',
    '.pptx': 'ppt',
    '.ppt': 'ppt',
    '.psd': 'psd',
    '.parquet': 'parquet',
    '.hwp': 'hwp',
    '.hwpx': 'hwp',
    '.zip': 'archive',
    '.jar': 'archive',
    '.apk': 'archive',
    '.tar': 'archive',
    '.tgz': 'archive',
    '.gz': 'archive',
    '.7z': 'archive',
    '.rar': 'archive'
};

/**
 * Returns the registry entry that should handle the given filename, based on
 * its extension. Returns `undefined` if no entry matches — the caller should
 * fall through to `renderUnsupportedFallback`.
 */
export function resolveRegistrationByFileName(
    fileName: string
): ViewerRegistration | undefined {
    const lower = fileName.toLowerCase();
    // Try multi-segment extensions first (e.g. ".tar.gz") so the longer match wins.
    const dotIdx = lower.lastIndexOf('.');
    if (dotIdx === -1) {
        return undefined;
    }

    const compoundIdx = lower.lastIndexOf('.', dotIdx - 1);
    if (compoundIdx !== -1) {
        const compoundExt = lower.slice(compoundIdx);
        const compoundSlug = EXTENSION_TO_SLUG[compoundExt];
        if (compoundSlug) {
            return getRegistrationBySlug(compoundSlug);
        }
    }

    const ext = lower.slice(dotIdx);
    const slug = EXTENSION_TO_SLUG[ext];
    return slug ? getRegistrationBySlug(slug) : undefined;
}
