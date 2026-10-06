// Parity harness for the two notebook detectors.
//
// `FileUtils.detectViewerType` and the legacy SPA's own `detectType` in
// `src/app.js` are independent implementations of the same routing rules, and
// the SPA is the one that ships. Each has its own suite, but a fixture tuned
// to one mirror's head window hides a disagreement rather than catching it —
// which is how a 16 KB / 64 KB window mismatch survived three review rounds.
// So every fixture here goes through BOTH and the answers must match,
// including sizes on either side of each window boundary.
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof NodeTextEncoder }).TextEncoder = NodeTextEncoder;
}
if (typeof (globalThis as { TextDecoder?: unknown }).TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof NodeTextDecoder }).TextDecoder =
        NodeTextDecoder as unknown as typeof TextDecoder;
}

import { FileUtils, shortNameForViewType } from '../utils/fileUtils';

/** SPA label (`labels` in app.js) for each short name the mirrors can return. */
const SPA_LABEL: Record<string, string> = {
    notebook: 'Jupyter Notebook',
    json: 'JSON',
    jsonl: 'JSONL'
};

function bytesOf(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

/** A `File` for FileUtils, which reads through `slice()` and `size`. */
function realFile(name: string, text: string): File {
    return new File([bytesOf(text)], name);
}

/**
 * A `File` stand-in for the SPA, whose `readHead` asks for the first 64 KB.
 * `size` stays the full length so `detectType` can tell a truncated head.
 */
function spaFile(name: string, text: string): File {
    const bytes = bytesOf(text);
    return {
        name,
        size: bytes.length,
        type: 'application/json',
        lastModified: 1,
        slice: jest.fn((start = 0, end = bytes.length) => ({
            arrayBuffer: () => Promise.resolve(bytes.slice(start, end).buffer)
        })),
        arrayBuffer: () => Promise.resolve(bytes.buffer),
        text: () => Promise.resolve(text)
    } as unknown as File;
}

async function detectInSpa(file: File): Promise<string> {
    document.body.innerHTML = `
        <button id="shareCurrentFile"></button>
        <button id="openSharedLink"></button>
        <select id="languageSelect"></select>
        <input id="fileInput" type="file" multiple>
        <div id="dropZone"></div>
        <div id="viewer"></div>
        <div id="status"></div>
        <div id="fileMeta"></div>
        <div id="shareToast"></div>
        <a id="shareToastLink"></a>
    `;
    let launchConsumer!: (
        params: { files: Array<{ getFile(): Promise<File> }> }
    ) => Promise<void>;
    Object.defineProperty(window, 'launchQueue', {
        configurable: true,
        value: { setConsumer: jest.fn((consumer) => { launchConsumer = consumer; }) }
    });
    (chrome.storage.local.get as jest.Mock).mockResolvedValue({});

    jest.isolateModules(() => {
        require('../app.js');
    });
    await launchConsumer({ files: [{ getFile: async () => file }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return document.querySelector('#fileMeta')?.textContent ?? '';
}

/** A notebook written cells-first (nbconvert / JupyterLab), padded to `size`. */
function cellsFirstNotebook(size: number): string {
    const tail = '"],"outputs":[]}],"metadata":{},"nbformat":4,"nbformat_minor":5}';
    const head = '{"cells":[{"cell_type":"code","execution_count":1,"source":["';
    return head + 'print(1)#'.repeat(Math.ceil(size / 9)) + tail;
}

/** A notebook written nbformat-first (Colab), padded to `size`. */
function nbformatFirstNotebook(size: number): string {
    return '{"nbformat":4,"nbformat_minor":0,"metadata":{"widgets":{"state":"'
        + 'w'.repeat(size)
        + '"}},"cells":[{"cell_type":"code","source":["print(1)"]}]}';
}

/** Not a notebook: a `cells` array, a `cell_type`, and no `nbformat`. */
function cellsWithoutNbformat(size: number): string {
    return '{"cells":[{"cell_type":"code","source":["'
        + 'x'.repeat(size)
        + '"]}],"metadata":{}}';
}

const CASES: Array<{ name: string; file: string; text: string; expected: string }> = [
    // Real notebooks, both key orderings, on both sides of the 64 KB head.
    { name: 'cells-first notebook inside the head', file: 'export.json', text: cellsFirstNotebook(1024), expected: 'notebook' },
    { name: 'cells-first notebook past the head', file: 'export.json', text: cellsFirstNotebook(70 * 1024), expected: 'notebook' },
    { name: 'nbformat-first notebook inside the head', file: 'colab.json', text: nbformatFirstNotebook(1024), expected: 'notebook' },
    { name: 'nbformat-first notebook past the head', file: 'colab.json', text: nbformatFirstNotebook(70 * 1024), expected: 'notebook' },
    { name: 'notebook keeping its extension', file: 'analysis.ipynb', text: cellsFirstNotebook(1024), expected: 'notebook' },

    // Sizes that sit between the old 16 KB sample and the 64 KB head — the
    // band where the two mirrors used to disagree.
    { name: 'notebook in the 16-64 KB band', file: 'export.json', text: cellsFirstNotebook(30 * 1024), expected: 'notebook' },
    { name: 'cells without nbformat in the 16-64 KB band', file: 'export.json', text: cellsWithoutNbformat(30 * 1024), expected: 'json' },

    // Not notebooks.
    { name: 'complete document with cells but no nbformat', file: 'export.json', text: cellsWithoutNbformat(32), expected: 'json' },
    {
        name: 'document that merely wraps a notebook',
        file: 'response.json',
        text: `{"name":"Untitled.ipynb","type":"notebook","content":${cellsFirstNotebook(64)}}`,
        expected: 'json'
    },
    {
        name: 'cell_type outside the cells array, past the head',
        file: 'schema.json',
        text: `{"cells":[{"id":1}],"schema":{"cell_type":"code","pad":"${'p'.repeat(70 * 1024)}"}}`,
        expected: 'json'
    },
    // A complete document is held to the core's rule — both keys — so one key
    // on its own only counts where the head is cut off.
    { name: 'complete document with nbformat but no cells', file: 'export.json', text: '{"nbformat":4,"nbformat_minor":5,"metadata":{}}', expected: 'json' },
    {
        name: 'nbformat with no cells, past the head',
        file: 'export.json',
        text: `{"nbformat":4,"nbformat_minor":5,"metadata":{"pad":"${'m'.repeat(70 * 1024)}"}}`,
        expected: 'notebook'
    },
    {
        name: 'line-delimited corpus of notebooks',
        file: 'notebooks.jsonl',
        text: `${cellsFirstNotebook(32)}\n${cellsFirstNotebook(32)}\n`,
        expected: 'jsonl'
    }
];

/**
 * One divergence the mirrors do NOT share, pinned here so it cannot drift
 * unnoticed. It is not the notebook sniff's doing: `FileUtils` has a generic
 * `looksLikeJsonDocument` content sniff that the SPA never ported, so an
 * EXTENSIONLESS JSON document has always shown as raw data in the SPA and as
 * the JSON tree in `FileUtils`. The notebook rules route notebook-shaped
 * documents that miss a key into exactly that path, which is why it is worth
 * a test rather than only a comment (`src/app.js`, end of `detectType`).
 */
const DOCUMENTED_DIVERGENCE = {
    file: 'export',
    text: cellsWithoutNbformat(32),
    fileUtils: 'json',
    spa: 'Raw Data'
};

describe('notebook detection parity between FileUtils and the SPA', () => {
    it.each(CASES)('agrees on $name', async ({ file, text, expected }) => {
        const detection = await FileUtils.detectViewerType(realFile(file, text));
        const shortName = detection.viewType ? shortNameForViewType(detection.viewType) : null;
        expect(shortName).toBe(expected);

        // The label is matched as a whole line: `JSONL` contains `JSON`, so a
        // substring check would pass for the wrong viewer.
        const meta = await detectInSpa(spaFile(file, text));
        const lines = meta.split('\n').map((line) => line.trim()).filter(Boolean);
        expect(lines).toContain(SPA_LABEL[expected]);
    });

    it('still splits on an extensionless non-notebook, as documented', async () => {
        const { file, text, fileUtils, spa } = DOCUMENTED_DIVERGENCE;
        const detection = await FileUtils.detectViewerType(realFile(file, text));
        expect(detection.viewType && shortNameForViewType(detection.viewType)).toBe(fileUtils);

        const meta = await detectInSpa(spaFile(file, text));
        const lines = meta.split('\n').map((line) => line.trim()).filter(Boolean);
        expect(lines).toContain(spa);
        // Neither mirror reaches the notebook viewer, which is the part that
        // matters for this feature.
        expect(lines).not.toContain(SPA_LABEL.notebook);
    });
});
