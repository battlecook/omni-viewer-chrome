// Pure validator + edit-state reducer for the JSONL viewer's
// click-to-edit feature (issue #60).
//
// Scope (per issue #60):
//   - `validateJson(text)` — try/catch JSON.parse, returning a tagged
//     union with a structured `{line, col}` for invalid input. The
//     position is parsed out of the native `SyntaxError` message
//     (Chrome / Node both surface "at position N"; we additionally
//     translate that offset back to a 1-based line + column for the
//     inline error display).
//   - `EditState` reducer — transitions between view / edit modes,
//     tracking the textarea draft, validation result, and a per-row
//     dirty bit so callers can decide whether Save should be enabled
//     and whether Cancel needs to revert anything.
//   - `assembleJsonl(originalLines, edits)` — produce the download
//     string by joining the per-row "current" text (edited if present,
//     otherwise the original).
//
// This module is intentionally DOM-free so it can be unit-tested
// without jsdom; the JSONL viewer's main module wires it up to the
// row + popup DOM in `jsonlViewerMain.ts`.
//
// The reducer is a "pure-ish" state machine: every action returns a
// brand-new `EditState` (no mutation), which makes the dirty / valid
// transitions easy to reason about and easy to test.

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

/**
 * Result of `validateJson`. We keep this as a tagged union rather
 * than a `T | null` so callers can distinguish "valid but happens to
 * parse to `null`" from "parse failed". On the invalid path we expose
 * the original error message verbatim plus a derived `{line, col}`
 * pair so the UI can render an inline pointer.
 */
export type JsonValidation =
    | { kind: 'valid'; value: unknown }
    | {
          kind: 'invalid';
          message: string;
          /** 1-based line number within `text`. */
          line: number;
          /** 1-based column within that line. */
          col: number;
          /**
           * 0-based character offset within `text`, or `-1` if the
           * message did not include a position hint. Exposed so
           * callers can place a marker without re-deriving from
           * `line`/`col`.
           */
          offset: number;
      };

/**
 * Try to `JSON.parse` `text`; on failure, derive a 1-based `(line,
 * col)` from the native `SyntaxError` so the JSONL editor can show a
 * helpful inline error.
 *
 * Whitespace-only input is treated as invalid (the JSONL editor must
 * not produce a row that is silently dropped on save). The error
 * message in that case is the synthetic `'Empty JSON value'`.
 */
export function validateJson(text: string): JsonValidation {
    if (text.trim().length === 0) {
        return {
            kind: 'invalid',
            message: 'Empty JSON value',
            line: 1,
            col: 1,
            offset: 0
        };
    }

    try {
        const value = JSON.parse(text) as unknown;
        return { kind: 'valid', value };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const offset = extractOffset(message);
        const { line, col } = offsetToLineCol(text, offset);
        return { kind: 'invalid', message, line, col, offset };
    }
}

/**
 * Extract the 0-based character offset that V8 / SpiderMonkey embed
 * in their `SyntaxError` messages, e.g. `"... at position 17"`. If
 * the message does not include such a hint we return `-1`.
 *
 * Exported for testing.
 */
export function extractOffset(message: string): number {
    // V8 / Chrome:   "Unexpected token } in JSON at position 17"
    //                "Expected property name or '}' in JSON at position 5"
    // Node 20+:      "... at position 17 (line 2 column 5)"
    const m = /at position (\d+)/.exec(message);
    if (!m) return -1;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : -1;
}

/**
 * Translate a 0-based `offset` within `text` into a 1-based `(line,
 * col)` pair. If `offset` is `-1` (no hint in the error) or out of
 * range we fall back to `(1, 1)` so the UI still has something to
 * render.
 *
 * Exported for testing.
 */
export function offsetToLineCol(
    text: string,
    offset: number
): { line: number; col: number } {
    if (offset < 0 || offset > text.length) {
        return { line: 1, col: 1 };
    }
    let line = 1;
    let col = 1;
    for (let i = 0; i < offset; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 10 /* \n */) {
            line++;
            col = 1;
        } else if (ch === 13 /* \r */) {
            // Treat CRLF as a single line break; if the next char is
            // \n we'll skip its accounting on the next iteration.
            line++;
            col = 1;
            if (text.charCodeAt(i + 1) === 10) i++;
        } else {
            col++;
        }
    }
    return { line, col };
}

// ---------------------------------------------------------------------------
// Edit-state reducer.
// ---------------------------------------------------------------------------

/**
 * Per-row edit state. The reducer treats the JSONL document as a
 * collection of rows where any individual row may be in `view` or
 * `edit` mode. Only one row is in `edit` mode at a time — when the
 * user clicks a different row the previous row's edit is implicitly
 * cancelled (the caller is responsible for prompting if it cares
 * about losing in-flight edits).
 */
export interface EditState {
    /**
     * Index of the row currently being edited, or `null` if no row is
     * in edit mode.
     */
    editingIndex: number | null;
    /**
     * Current textarea contents while editing. Only meaningful when
     * `editingIndex !== null`.
     */
    draft: string;
    /**
     * The original row text snapshotted at the moment editing began.
     * Used by the dirty check + cancel path. Empty string when not
     * editing.
     */
    originalDraft: string;
    /**
     * Latest validation result for `draft`. Recomputed on every
     * `update` action so the UI can reflect live validation.
     */
    validation: JsonValidation;
    /**
     * Per-row map of saved edits. Keyed by row index; the value is
     * the row's text as last saved. Rows absent from this map are
     * still in their original form.
     *
     * Stored as a plain object (rather than `Map`) because the
     * reducer is pure and we serialise into a fresh copy on every
     * mutation.
     */
    edits: Record<number, string>;
}

/** Build the initial state — view mode, no edits, default validation. */
export function initialEditState(): EditState {
    return {
        editingIndex: null,
        draft: '',
        originalDraft: '',
        validation: { kind: 'valid', value: undefined },
        edits: {}
    };
}

export type EditAction =
    | { type: 'beginEdit'; index: number; original: string }
    | { type: 'updateDraft'; text: string }
    | { type: 'save' }
    | { type: 'cancel' };

/**
 * Pure reducer. Returns a new `EditState` for each action; never
 * mutates the input. Unknown / illegal transitions (e.g. `save`
 * while no row is in edit mode) return the input state unchanged so
 * callers can defensively dispatch without a precondition check.
 *
 * Save additionally refuses to commit when the current draft is
 * invalid — the caller is expected to disable the Save button in
 * that case, but the reducer guards against it as a belt-and-braces
 * measure.
 */
export function reduce(state: EditState, action: EditAction): EditState {
    switch (action.type) {
        case 'beginEdit': {
            // If a different row was already being edited we drop its
            // in-flight draft; the caller is responsible for warning
            // before triggering this transition if it cares.
            return {
                ...state,
                editingIndex: action.index,
                draft: action.original,
                originalDraft: action.original,
                validation: validateJson(action.original)
            };
        }
        case 'updateDraft': {
            if (state.editingIndex === null) return state;
            return {
                ...state,
                draft: action.text,
                validation: validateJson(action.text)
            };
        }
        case 'save': {
            if (state.editingIndex === null) return state;
            if (state.validation.kind !== 'valid') return state;
            const idx = state.editingIndex;
            return {
                ...state,
                editingIndex: null,
                draft: '',
                originalDraft: '',
                validation: { kind: 'valid', value: undefined },
                edits: { ...state.edits, [idx]: state.draft }
            };
        }
        case 'cancel': {
            if (state.editingIndex === null) return state;
            return {
                ...state,
                editingIndex: null,
                draft: '',
                originalDraft: '',
                validation: { kind: 'valid', value: undefined }
            };
        }
        default:
            return state;
    }
}

/**
 * `true` when the current draft differs from the snapshot taken at
 * `beginEdit`. Used by the UI to enable / disable Save and to
 * decide whether Cancel is destructive.
 */
export function isDirty(state: EditState): boolean {
    if (state.editingIndex === null) return false;
    return state.draft !== state.originalDraft;
}

// ---------------------------------------------------------------------------
// Download assembly.
// ---------------------------------------------------------------------------

/**
 * Assemble the full JSONL document for download. Rows that have a
 * saved edit in `edits` use the edited text; everything else falls
 * back to the original line. The result is the rows joined by `\n`
 * (no trailing newline — matches what `splitJsonlLines` emits).
 *
 * Pure function: never mutates either input.
 */
export function assembleJsonl(
    originalLines: ReadonlyArray<string>,
    edits: Readonly<Record<number, string>>
): string {
    const out: string[] = new Array(originalLines.length);
    for (let i = 0; i < originalLines.length; i++) {
        out[i] = Object.prototype.hasOwnProperty.call(edits, i)
            ? edits[i]
            : originalLines[i];
    }
    return out.join('\n');
}
