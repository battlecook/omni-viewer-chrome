// Tests for the JSONL viewer's syntax-highlight rendering (issue #61).
//
// The full tokenizer is exhaustively covered by `jsonTokenizer.test.ts`
// — these tests deliberately stay narrow and focus on the JSONL-side
// integration:
//
//   1. `buildHighlightedFragment` emits one `<span class="jl-tok-...">`
//      per non-whitespace token, with the expected class names for
//      keys / strings / numbers / booleans / null / punct.
//   2. Whitespace stays as plain text nodes (NOT span-wrapped) so the
//      DOM stays small for big lines.
//   3. The concatenated `textContent` of the fragment reconstructs the
//      original input verbatim — i.e. highlighting is non-lossy.
//   4. Mounting `mountJsonlViewer` with a representative JSONL payload
//      produces rows whose `.jl-line-content` contains the expected
//      `.jl-tok-*` classes and renders invalid lines without coloured
//      spans (the badge path stays as plain text).
//
// We run under jsdom (project default).

import { buildHighlightedFragment, mountJsonlViewer } from '../templates/jsonl/js/jsonlViewerMain';

// ---------------------------------------------------------------------------
// buildHighlightedFragment — pure DOM emission.
// ---------------------------------------------------------------------------

function classesIn(node: ParentNode): string[] {
    return Array.from(node.querySelectorAll('span'))
        .map((s) => s.className)
        .filter((c) => c.startsWith('jl-tok-'));
}

function reconstruct(node: ParentNode): string {
    // textContent walks all descendants in DOM order — same as
    // concatenating tokens.text for the underlying tokenizer.
    return (node as unknown as { textContent: string }).textContent;
}

describe('buildHighlightedFragment', () => {
    it('emits the expected token classes for an object with mixed primitives', () => {
        const frag = buildHighlightedFragment('{"a":"x","b":1,"c":true,"d":null}');
        const host = document.createElement('div');
        host.appendChild(frag);

        const classes = classesIn(host);
        // Order: { "a" : "x" , "b" : 1 , "c" : true , "d" : null }
        expect(classes).toEqual([
            'jl-tok-punct',  // {
            'jl-tok-key',    // "a"
            'jl-tok-punct',  // :
            'jl-tok-string', // "x"
            'jl-tok-punct',  // ,
            'jl-tok-key',    // "b"
            'jl-tok-punct',  // :
            'jl-tok-number', // 1
            'jl-tok-punct',  // ,
            'jl-tok-key',    // "c"
            'jl-tok-punct',  // :
            'jl-tok-bool',   // true
            'jl-tok-punct',  // ,
            'jl-tok-key',    // "d"
            'jl-tok-punct',  // :
            'jl-tok-null',   // null
            'jl-tok-punct'   // }
        ]);
    });

    it('does NOT colour numbers as strings (and vice versa)', () => {
        const frag = buildHighlightedFragment('{"id":42,"name":"42"}');
        const host = document.createElement('div');
        host.appendChild(frag);

        const numberSpans = host.querySelectorAll('.jl-tok-number');
        const stringSpans = host.querySelectorAll('.jl-tok-string');

        expect(numberSpans.length).toBe(1);
        expect(numberSpans[0].textContent).toBe('42');

        expect(stringSpans.length).toBe(1);
        expect(stringSpans[0].textContent).toBe('"42"');
    });

    it('preserves whitespace as plain text nodes (no jl-tok span)', () => {
        const frag = buildHighlightedFragment('{ "a" : 1 }');
        const host = document.createElement('div');
        host.appendChild(frag);

        // Total spans should match the count of non-whitespace tokens
        // only (5: { "a" : 1 }) — whitespace is bare text nodes.
        const allTokSpans = host.querySelectorAll('span[class^="jl-tok-"]');
        expect(allTokSpans.length).toBe(5);
    });

    it('reconstructs the original input verbatim', () => {
        const samples = [
            '{"a":1}',
            '[1,2,3]',
            '{"nested":{"k":"v"},"arr":[true,false,null]}',
            '   {"leading":"ws"}   ',
            '{"escaped":"a\\"b"}'
        ];
        for (const raw of samples) {
            const frag = buildHighlightedFragment(raw);
            const host = document.createElement('div');
            host.appendChild(frag);
            expect(reconstruct(host)).toBe(raw);
        }
    });

    it('emits jl-tok-unknown for malformed trailing input without throwing', () => {
        // `@@@` cannot start any real JSON token — the tokenizer
        // collapses it into a single `unknown` run.
        expect(() => buildHighlightedFragment('@@@')).not.toThrow();
        const frag = buildHighlightedFragment('@@@');
        const host = document.createElement('div');
        host.appendChild(frag);
        expect(host.querySelectorAll('.jl-tok-unknown').length).toBe(1);
    });

    it('returns an empty fragment for an empty string', () => {
        const frag = buildHighlightedFragment('');
        expect(frag.childNodes.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// mountJsonlViewer — integration check.
// ---------------------------------------------------------------------------

/** Minimal File-like stub — `mountJsonlViewer` only needs `.text()`,
 *  and jsdom's File implementation can be flaky about it across
 *  versions. We hand-roll a duck-typed object with the single method
 *  the viewer touches and cast it across the boundary. */
function makeFile(text: string): File {
    const fileLike = {
        text: () => Promise.resolve(text),
        name: 'fixture.jsonl',
        size: text.length,
        type: 'application/x-ndjson'
    };
    return fileLike as unknown as File;
}

describe('mountJsonlViewer — syntax highlight integration', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    it('renders valid rows with jl-tok-* spans inside .jl-line-content', async () => {
        const file = makeFile('{"name":"alice","age":30}\n{"name":"bob","age":25}\n');
        const handle = await mountJsonlViewer(file, container);

        const rows = container.querySelectorAll('.jl-row');
        expect(rows.length).toBe(2);

        for (const row of Array.from(rows)) {
            const content = row.querySelector('.jl-line-content');
            expect(content).not.toBeNull();
            // Each row has at least one key, one string value, and one number.
            expect(content!.querySelectorAll('.jl-tok-key').length).toBeGreaterThanOrEqual(2);
            expect(content!.querySelectorAll('.jl-tok-string').length).toBeGreaterThanOrEqual(1);
            expect(content!.querySelectorAll('.jl-tok-number').length).toBeGreaterThanOrEqual(1);
        }

        handle.dispose();
    });

    it('does NOT add jl-tok spans to invalid rows (badge path stays plain)', async () => {
        const file = makeFile('{"valid":1}\n{not valid json}\n');
        const handle = await mountJsonlViewer(file, container);

        const rows = container.querySelectorAll('.jl-row');
        expect(rows.length).toBe(2);

        const validRow = rows[0];
        const invalidRow = rows[1];

        expect(validRow.querySelectorAll('.jl-tok-key').length).toBeGreaterThan(0);
        expect(invalidRow.classList.contains('jl-invalid')).toBe(true);
        // Invalid rows should never run through the tokeniser.
        expect(invalidRow.querySelectorAll('span[class^="jl-tok-"]').length).toBe(0);
        // Sanity: the invalid badge is still there.
        expect(invalidRow.querySelector('.jl-invalid-badge')).not.toBeNull();

        handle.dispose();
    });

    it('reconstructs original line text via highlighted spans (lossless)', async () => {
        const raw = '{"k":[1,2,3],"s":"hi","b":false}';
        const file = makeFile(raw + '\n');
        const handle = await mountJsonlViewer(file, container);

        const content = container.querySelector('.jl-row .jl-line-content');
        expect(content).not.toBeNull();
        expect(content!.textContent).toBe(raw);

        handle.dispose();
    });
});
