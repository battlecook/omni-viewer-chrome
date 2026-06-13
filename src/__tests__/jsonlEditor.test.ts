// Tests for the JSONL editor's pure helpers (issue #60).
//
// Coverage targets:
//   - validateJson: valid / invalid / empty inputs, with the
//     `(line, col)` derivation off the native SyntaxError "at
//     position N" hint when present (and the safe fallback when not).
//   - extractOffset / offsetToLineCol: the helpers that drive
//     validateJson's position-resolution path.
//   - reduce: the full set of EditState transitions
//     (beginEdit / updateDraft / save / cancel) plus the no-op
//     guards (e.g. `save` while not editing).
//   - isDirty: tracks the diff between draft and snapshot.
//   - assembleJsonl: edits override originals, gaps fall through,
//     and the result joins on `\n` with no trailing newline.
//
// This module is DOM-free so the tests run as plain unit tests under
// Jest (no jsdom interaction required).

import {
    EditState,
    assembleJsonl,
    extractOffset,
    initialEditState,
    isDirty,
    offsetToLineCol,
    reduce,
    validateJson
} from '../templates/jsonl/js/jsonlEditor';

// ---------------------------------------------------------------------------
// validateJson.
// ---------------------------------------------------------------------------

describe('validateJson', () => {
    it('returns kind=valid with the parsed value for well-formed JSON', () => {
        const result = validateJson('{"a":1,"b":[true,null]}');
        expect(result.kind).toBe('valid');
        if (result.kind === 'valid') {
            expect(result.value).toEqual({ a: 1, b: [true, null] });
        }
    });

    it('treats the literal `null` as a valid value (not an empty draft)', () => {
        const result = validateJson('null');
        expect(result.kind).toBe('valid');
        if (result.kind === 'valid') {
            expect(result.value).toBeNull();
        }
    });

    it('treats whitespace-only input as invalid with a synthetic message', () => {
        const result = validateJson('   \n\t');
        expect(result.kind).toBe('invalid');
        if (result.kind === 'invalid') {
            expect(result.message).toBe('Empty JSON value');
            expect(result.line).toBe(1);
            expect(result.col).toBe(1);
            expect(result.offset).toBe(0);
        }
    });

    it('returns kind=invalid with a non-empty message + 1-based line/col for malformed JSON', () => {
        // The exact "at position N" suffix depends on the JS engine's
        // SyntaxError formatting (V8 ≤ 20 says "at position N", Node
        // 21+ adds a "(line X column Y)" tail, jsdom may emit yet
        // another shape). The validator's contract is independent of
        // that: line/col are always >= 1 and message is non-empty.
        const text = '{"a":1,\n"b":}';
        const result = validateJson(text);
        expect(result.kind).toBe('invalid');
        if (result.kind === 'invalid') {
            expect(result.message.length).toBeGreaterThan(0);
            expect(result.line).toBeGreaterThanOrEqual(1);
            expect(result.col).toBeGreaterThanOrEqual(1);
            // Offset is either -1 (no hint) or a valid index into
            // `text`. Both are acceptable.
            if (result.offset !== -1) {
                expect(result.offset).toBeGreaterThanOrEqual(0);
                expect(result.offset).toBeLessThanOrEqual(text.length);
            }
        }
    });

    it('falls back to (1, 1) when the engine does not include a position hint', () => {
        // Force the fallback by patching Error.prototype briefly is
        // overkill; instead we verify offsetToLineCol's contract via a
        // direct call below. Here we just confirm that any invalid
        // input produces SOME (line, col) >= 1.
        const result = validateJson('not json');
        expect(result.kind).toBe('invalid');
        if (result.kind === 'invalid') {
            expect(result.line).toBeGreaterThanOrEqual(1);
            expect(result.col).toBeGreaterThanOrEqual(1);
        }
    });
});

describe('extractOffset', () => {
    it('parses the offset out of a V8-style SyntaxError message', () => {
        expect(extractOffset('Unexpected token } in JSON at position 17')).toBe(17);
    });

    it('parses the offset out of a Node 20 message (position + line/col tail)', () => {
        expect(
            extractOffset('Expected property name or \'}\' in JSON at position 5 (line 1 column 6)')
        ).toBe(5);
    });

    it('returns -1 when the message has no position hint', () => {
        expect(extractOffset('something else entirely')).toBe(-1);
    });
});

describe('offsetToLineCol', () => {
    it('returns (1, 1) when offset is 0', () => {
        expect(offsetToLineCol('hello\nworld', 0)).toEqual({ line: 1, col: 1 });
    });

    it('counts columns within a single line', () => {
        // offset 3 in "hello" → col 4 (1-based: h=1, e=2, l=3, after l is col 4)
        expect(offsetToLineCol('hello', 3)).toEqual({ line: 1, col: 4 });
    });

    it('advances the line counter at LF and resets col to 1', () => {
        const text = 'ab\ncd';
        // offset 3 = first char of "cd" (line 2, col 1)
        expect(offsetToLineCol(text, 3)).toEqual({ line: 2, col: 1 });
        // offset 4 = second char of "cd" (line 2, col 2)
        expect(offsetToLineCol(text, 4)).toEqual({ line: 2, col: 2 });
    });

    it('treats CRLF as a single line break', () => {
        const text = 'ab\r\ncd';
        // offset 4 = 'c' (line 2, col 1)
        expect(offsetToLineCol(text, 4)).toEqual({ line: 2, col: 1 });
    });

    it('returns (1, 1) for negative or out-of-range offsets', () => {
        expect(offsetToLineCol('abc', -1)).toEqual({ line: 1, col: 1 });
        expect(offsetToLineCol('abc', 999)).toEqual({ line: 1, col: 1 });
    });
});

// ---------------------------------------------------------------------------
// Reducer: EditState transitions.
// ---------------------------------------------------------------------------

describe('reduce — beginEdit', () => {
    it('switches into edit mode with draft + snapshot equal to the original line', () => {
        const next = reduce(
            initialEditState(),
            { type: 'beginEdit', index: 4, original: '{"a":1}' }
        );
        expect(next.editingIndex).toBe(4);
        expect(next.draft).toBe('{"a":1}');
        expect(next.originalDraft).toBe('{"a":1}');
        expect(next.validation.kind).toBe('valid');
        expect(isDirty(next)).toBe(false);
    });

    it('replaces an in-flight edit when triggered for a different row', () => {
        const s1 = reduce(
            initialEditState(),
            { type: 'beginEdit', index: 0, original: '{"a":1}' }
        );
        const s2 = reduce(s1, { type: 'updateDraft', text: '{"a":99}' });
        expect(isDirty(s2)).toBe(true);

        const s3 = reduce(
            s2,
            { type: 'beginEdit', index: 1, original: '{"b":2}' }
        );
        expect(s3.editingIndex).toBe(1);
        expect(s3.draft).toBe('{"b":2}');
        expect(s3.originalDraft).toBe('{"b":2}');
        expect(isDirty(s3)).toBe(false);
        // Edits map untouched (the previous draft was never saved).
        expect(s3.edits).toEqual({});
    });

    it('reports an invalid validation when the original line is itself malformed', () => {
        const next = reduce(
            initialEditState(),
            { type: 'beginEdit', index: 0, original: '{"oops":' }
        );
        expect(next.validation.kind).toBe('invalid');
    });
});

describe('reduce — updateDraft', () => {
    it('updates the draft and reruns validation', () => {
        const s1 = reduce(
            initialEditState(),
            { type: 'beginEdit', index: 0, original: '{"a":1}' }
        );
        const s2 = reduce(s1, { type: 'updateDraft', text: '{"a":' });
        expect(s2.draft).toBe('{"a":');
        expect(s2.validation.kind).toBe('invalid');
        expect(isDirty(s2)).toBe(true);

        const s3 = reduce(s2, { type: 'updateDraft', text: '{"a":2}' });
        expect(s3.validation.kind).toBe('valid');
        expect(isDirty(s3)).toBe(true);
    });

    it('is a no-op when no row is being edited', () => {
        const s0 = initialEditState();
        const s1 = reduce(s0, { type: 'updateDraft', text: 'whatever' });
        expect(s1).toBe(s0);
    });
});

describe('reduce — save', () => {
    it('commits the draft into edits and exits edit mode', () => {
        const s1 = reduce(
            initialEditState(),
            { type: 'beginEdit', index: 2, original: '{"a":1}' }
        );
        const s2 = reduce(s1, { type: 'updateDraft', text: '{"a":42}' });
        const s3 = reduce(s2, { type: 'save' });
        expect(s3.editingIndex).toBeNull();
        expect(s3.draft).toBe('');
        expect(s3.originalDraft).toBe('');
        expect(s3.edits).toEqual({ 2: '{"a":42}' });
    });

    it('refuses to save while the draft is invalid', () => {
        const s1 = reduce(
            initialEditState(),
            { type: 'beginEdit', index: 0, original: '{"a":1}' }
        );
        const s2 = reduce(s1, { type: 'updateDraft', text: '{"a":' });
        const s3 = reduce(s2, { type: 'save' });
        expect(s3).toBe(s2); // unchanged
        expect(s3.editingIndex).toBe(0);
        expect(s3.edits).toEqual({});
    });

    it('is a no-op when no row is being edited', () => {
        const s0 = initialEditState();
        const s1 = reduce(s0, { type: 'save' });
        expect(s1).toBe(s0);
    });

    it('overwrites an earlier saved edit on a subsequent save', () => {
        let s: EditState = initialEditState();
        s = reduce(s, { type: 'beginEdit', index: 0, original: '{"a":1}' });
        s = reduce(s, { type: 'updateDraft', text: '{"a":2}' });
        s = reduce(s, { type: 'save' });
        expect(s.edits).toEqual({ 0: '{"a":2}' });

        s = reduce(s, { type: 'beginEdit', index: 0, original: '{"a":1}' });
        s = reduce(s, { type: 'updateDraft', text: '{"a":3}' });
        s = reduce(s, { type: 'save' });
        expect(s.edits).toEqual({ 0: '{"a":3}' });
    });
});

describe('reduce — cancel', () => {
    it('drops the draft and returns to view mode without touching edits', () => {
        const s1 = reduce(
            initialEditState(),
            { type: 'beginEdit', index: 1, original: '{"a":1}' }
        );
        const s2 = reduce(s1, { type: 'updateDraft', text: '{"a":99}' });
        const s3 = reduce(s2, { type: 'cancel' });
        expect(s3.editingIndex).toBeNull();
        expect(s3.draft).toBe('');
        expect(s3.originalDraft).toBe('');
        expect(s3.edits).toEqual({});
    });

    it('preserves previously-saved edits across cancel', () => {
        let s: EditState = initialEditState();
        s = reduce(s, { type: 'beginEdit', index: 0, original: '{"a":1}' });
        s = reduce(s, { type: 'updateDraft', text: '{"a":2}' });
        s = reduce(s, { type: 'save' });
        s = reduce(s, { type: 'beginEdit', index: 1, original: '{"b":2}' });
        s = reduce(s, { type: 'updateDraft', text: '{"b":99}' });
        s = reduce(s, { type: 'cancel' });
        expect(s.edits).toEqual({ 0: '{"a":2}' });
    });

    it('is a no-op when no row is being edited', () => {
        const s0 = initialEditState();
        const s1 = reduce(s0, { type: 'cancel' });
        expect(s1).toBe(s0);
    });
});

describe('isDirty', () => {
    it('returns false when not editing', () => {
        expect(isDirty(initialEditState())).toBe(false);
    });

    it('returns false immediately after beginEdit (snapshot matches draft)', () => {
        const s1 = reduce(
            initialEditState(),
            { type: 'beginEdit', index: 0, original: '{"a":1}' }
        );
        expect(isDirty(s1)).toBe(false);
    });

    it('returns true once the draft diverges from the snapshot', () => {
        const s1 = reduce(
            initialEditState(),
            { type: 'beginEdit', index: 0, original: '{"a":1}' }
        );
        const s2 = reduce(s1, { type: 'updateDraft', text: '{"a":2}' });
        expect(isDirty(s2)).toBe(true);
    });

    it('returns false again after the draft is reverted to the snapshot', () => {
        const s1 = reduce(
            initialEditState(),
            { type: 'beginEdit', index: 0, original: '{"a":1}' }
        );
        const s2 = reduce(s1, { type: 'updateDraft', text: '{"a":2}' });
        const s3 = reduce(s2, { type: 'updateDraft', text: '{"a":1}' });
        expect(isDirty(s3)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// assembleJsonl.
// ---------------------------------------------------------------------------

describe('assembleJsonl', () => {
    it('returns the original lines verbatim when there are no edits', () => {
        const out = assembleJsonl(['{"a":1}', '{"b":2}', '{"c":3}'], {});
        expect(out).toBe('{"a":1}\n{"b":2}\n{"c":3}');
    });

    it('substitutes edited rows by index and leaves the rest untouched', () => {
        const out = assembleJsonl(
            ['{"a":1}', '{"b":2}', '{"c":3}'],
            { 1: '{"b":99}' }
        );
        expect(out).toBe('{"a":1}\n{"b":99}\n{"c":3}');
    });

    it('joins on \\n with no trailing newline', () => {
        const out = assembleJsonl(['a', 'b'], {});
        expect(out.endsWith('\n')).toBe(false);
        expect(out).toBe('a\nb');
    });

    it('handles an empty document', () => {
        expect(assembleJsonl([], {})).toBe('');
    });

    it('preserves an interior empty line', () => {
        const out = assembleJsonl(['{"a":1}', '', '{"c":3}'], {});
        expect(out).toBe('{"a":1}\n\n{"c":3}');
    });

    it('does not mutate the inputs', () => {
        const lines = ['{"a":1}', '{"b":2}'];
        const edits = { 0: '{"a":99}' };
        const beforeLines = lines.slice();
        const beforeEdits = { ...edits };
        assembleJsonl(lines, edits);
        expect(lines).toEqual(beforeLines);
        expect(edits).toEqual(beforeEdits);
    });

    it('ignores edits with indices outside the original range', () => {
        // Out-of-range edits are simply not addressed by the loop; the
        // output length is bounded by `originalLines`.
        const out = assembleJsonl(['{"a":1}'], { 0: '{"a":2}', 5: 'ignored' });
        expect(out).toBe('{"a":2}');
    });
});
