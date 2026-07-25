// Orchestration layer for the JSONL viewer (issue #59 — Hover popup;
// extended in #61 for syntax highlighting).
//
// Scope (per issue #59):
//   1. Read the file as text, split into lines, render each line as a row.
//   2. Cache the parsed JSON value per line so the popup body can be
//      built without reparsing on every hover.
//   3. On `mouseenter` over a valid row, schedule a debounced (~150ms)
//      popup with `JSON.stringify(parsed, null, 2)`. On `mouseleave`,
//      hide immediately (per the issue DoD).
//   4. Lines that fail to parse render with an "invalid JSON" badge and
//      do NOT trigger the popup.
//
// Issue #61 additions:
//   - Each successfully-parsed line is tokenised via the shared
//     `tokenizeJson` from #63 and rendered as a sequence of
//     `<span class="jl-tok-...">` fragments. Whitespace tokens are
//     emitted as plain text nodes so the row keeps its layout without
//     bloating the DOM.
//   - Per-line rendered fragments are cached (`fragments[i]`) so a
//     re-render path (future virtualisation, search highlight, etc.)
//     can reuse them without re-tokenising.
//
// Issue #60 additions:
//   - Clicking a row toggles a popup "edit mode": the hover popup
//     becomes interactive, with a `<textarea>` containing the row's
//     text plus Save / Cancel / Download buttons.
//   - Live validation: the textarea is parsed on every input via
//     `validateJson` from `jsonlEditor.ts`; on failure we show the
//     `error.message` plus a 1-based `(line, col)` pointer.
//   - Save: tokenises the new text via the shared `tokenizeJson`,
//     invalidates the cached fragment for that row, swaps the row
//     content in place, and stores the edit in the editor reducer
//     so a later Download exports the updated document.
//   - Cancel: drops the draft, leaves the row + cache untouched.
//   - Download: assembles the JSONL by mixing original + edited
//     lines via `assembleJsonl`, then triggers an `<a download>` on
//     a Blob URL.
//
// Performance:
//   The issue's DoD is hover smoothness, not full virtualisation. For
//   files with 100k+ lines we render the first `INITIAL_BATCH_SIZE`
//   rows up-front and expose a "Load more" button that appends another
//   batch each click. Each batch is built via DocumentFragment so the
//   DOM cost is paid in one re-flow.

import {
    ParsedLine,
    PopupHandle,
    attachPopup,
    parseJsonlLine,
    splitJsonlLines
} from './jsonlPopup';
import { JSONL_VIEWER_CSS } from './jsonlViewerStyles';
// Cross-template import: the JSON viewer (#63) owns the tokenizer; we
// import it directly because it is a pure, DOM-free module shared
// between the JSON and JSONL viewers per the issue plan.
import { JsonToken, tokenizeJson } from '../../json/js/jsonTokenizer';
import {
    EditAction,
    EditState,
    JsonValidation,
    assembleJsonl,
    initialEditState,
    isDirty,
    reduce
} from './jsonlEditor';

const STYLE_ELEMENT_ID = 'omni-viewer-jsonl-styles';

/** Number of rows materialised on first render. */
export const INITIAL_BATCH_SIZE = 5000;

/** Number of rows materialised by each subsequent "Load more" click. */
export const LOAD_MORE_BATCH_SIZE = 5000;

/** Hover debounce in ms. The issue spec calls for ~150. */
export const HOVER_DELAY_MS = 150;

export interface JsonlViewerHandle {
    dispose(): void;
}

interface ViewerDom {
    root: HTMLElement;
    toolbar: HTMLElement;
    info: HTMLElement;
    downloadBtn: HTMLButtonElement;
    loadMoreBtn: HTMLButtonElement;
    list: HTMLElement;
}

interface ViewerState {
    lines: string[];
    /** Parsed cache, lazily populated as rows are materialised. */
    parsed: Array<ParsedLine | undefined>;
    /**
     * Per-line cache of the highlighted DOM fragment. We store the
     * tokenised children of `.jl-line-content` (NOT the row itself) so
     * any caller wanting to re-mount a row can clone these nodes
     * without re-tokenising. Entries are populated lazily as rows are
     * materialised; we only cache for valid lines (invalid / empty
     * lines have nothing to colour).
     */
    fragments: Array<DocumentFragment | undefined>;
    /** How many rows are currently in the DOM. */
    rendered: number;
    /** Editor reducer state (issue #60). */
    edit: EditState;
}

function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = JSONL_VIEWER_CSS;
    document.head.appendChild(style);
}

/**
 * Mount the JSONL viewer into `container`. Returns a handle whose
 * `dispose()` clears the container, removes the popup, and detaches
 * any listeners.
 */
export async function mountJsonlViewer(
    file: File,
    container: HTMLElement
): Promise<JsonlViewerHandle> {
    ensureStylesInjected();
    container.innerHTML = '';
    container.classList.add('jl-host');

    const dom = buildShell(container);

    let text: string;
    try {
        text = await file.text();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        renderError(dom.list, `Failed to read file: ${message}`);
        return makeHandle(container, () => {});
    }

    const lines = splitJsonlLines(text);
    const state: ViewerState = {
        lines,
        parsed: new Array(lines.length).fill(undefined),
        fragments: new Array(lines.length).fill(undefined),
        rendered: 0,
        edit: initialEditState()
    };

    // Popup is attached to <body> (not the container) so `position: fixed`
    // coordinates from `clampPopupPosition` work without being affected by
    // the container's transform / scroll context.
    const popupHost = container.ownerDocument?.body ?? container;
    const popup = attachPopup(popupHost, {
        defaultDelayMs: HOVER_DELAY_MS,
        className: 'omni-jsonl-popup'
    });

    const editor = createEditorController(state, dom, popup, file.name);

    renderInitialBatch(state, dom, popup, editor);
    updateInfo(state, dom);

    const onLoadMore = () => {
        renderMore(state, dom, popup, editor, LOAD_MORE_BATCH_SIZE);
        updateInfo(state, dom);
    };
    dom.loadMoreBtn.addEventListener('click', onLoadMore);

    const onDownload = () => editor.download();
    dom.downloadBtn.addEventListener('click', onDownload);

    return makeHandle(container, () => {
        dom.loadMoreBtn.removeEventListener('click', onLoadMore);
        dom.downloadBtn.removeEventListener('click', onDownload);
        editor.dispose();
        popup.dispose();
    });
}

function makeHandle(container: HTMLElement, cleanup: () => void): JsonlViewerHandle {
    return {
        dispose() {
            cleanup();
            container.innerHTML = '';
            container.classList.remove('jl-host');
        }
    };
}

// ---------------------------------------------------------------------------
// Shell DOM.
// ---------------------------------------------------------------------------

function buildShell(container: HTMLElement): ViewerDom {
    const root = document.createElement('div');
    root.className = 'jl-container';

    const toolbar = document.createElement('div');
    toolbar.className = 'jl-toolbar';

    const info = document.createElement('span');
    info.className = 'jl-info';
    info.textContent = '';

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'jl-download';
    downloadBtn.textContent = 'Download';
    downloadBtn.title = 'Download the (possibly edited) JSONL file';

    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.type = 'button';
    loadMoreBtn.className = 'jl-load-more';
    loadMoreBtn.textContent = 'Load more';
    loadMoreBtn.style.display = 'none';

    toolbar.append(info, downloadBtn, loadMoreBtn);

    const list = document.createElement('div');
    list.className = 'jl-list';

    root.append(toolbar, list);
    container.appendChild(root);

    return { root, toolbar, info, downloadBtn, loadMoreBtn, list };
}

function renderError(list: HTMLElement, message: string): void {
    list.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'jl-error';
    err.setAttribute('role', 'alert');
    err.textContent = message;
    list.appendChild(err);
}

// ---------------------------------------------------------------------------
// Row rendering.
// ---------------------------------------------------------------------------

function renderInitialBatch(
    state: ViewerState,
    dom: ViewerDom,
    popup: PopupHandle,
    editor: EditorController
): void {
    renderMore(state, dom, popup, editor, INITIAL_BATCH_SIZE);
}

function renderMore(
    state: ViewerState,
    dom: ViewerDom,
    popup: PopupHandle,
    editor: EditorController,
    batchSize: number
): void {
    const start = state.rendered;
    const end = Math.min(state.lines.length, start + batchSize);
    if (end <= start) return;

    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
        const raw = state.lines[i];
        const parsed = parseJsonlLine(raw);
        state.parsed[i] = parsed;
        const row = buildRow(state, i, raw, parsed, popup, editor);
        frag.appendChild(row);
    }
    dom.list.appendChild(frag);
    state.rendered = end;
}

function buildRow(
    state: ViewerState,
    index: number,
    raw: string,
    parsed: ParsedLine,
    popup: PopupHandle,
    editor: EditorController
): HTMLElement {
    const row = document.createElement('div');
    row.className = 'jl-row';
    row.dataset.lineIndex = String(index);

    const lineNumber = document.createElement('span');
    lineNumber.className = 'jl-line-number';
    lineNumber.textContent = String(index + 1);
    row.appendChild(lineNumber);

    const content = document.createElement('span');
    content.className = 'jl-line-content';
    populateRowContent(state, index, raw, parsed, row, content);

    row.appendChild(content);

    // Hover handlers: only valid lines trigger the popup. Invalid lines
    // already surface their error via the badge tooltip; empty lines have
    // nothing to show.
    if (parsed.kind === 'valid') {
        const formatted = parsed.formatted;
        row.addEventListener('mouseenter', (event: MouseEvent) => {
            if (editor.isEditing()) return;
            popup.scheduleShow(formatted, event.clientX, event.clientY);
        });
        // Track cursor across the row so the popup follows reasonably
        // even if `mouseenter` coordinates are stale by the time the
        // debounce fires.
        row.addEventListener('mousemove', (event: MouseEvent) => {
            if (editor.isEditing()) return;
            popup.scheduleShow(formatted, event.clientX, event.clientY);
        });
        row.addEventListener('mouseleave', () => {
            if (editor.isEditing()) return;
            // Issue #59 DoD: mouseleave hides immediately.
            popup.hide();
        });
    }

    // Issue #60: any row (valid, invalid, even empty) is clickable so
    // the user can edit malformed lines into shape.
    row.addEventListener('click', (event: MouseEvent) => {
        editor.beginEdit(index, row, event.clientX, event.clientY);
    });

    return row;
}

/**
 * Fill `.jl-line-content` for the given row + parsed result. Extracted
 * from `buildRow` so the editor's Save path can reuse it to re-render
 * the row in place after an edit (issue #60 step 3).
 */
function populateRowContent(
    state: ViewerState,
    index: number,
    raw: string,
    parsed: ParsedLine,
    row: HTMLElement,
    content: HTMLElement
): void {
    content.textContent = '';
    row.classList.remove('jl-invalid', 'jl-empty');

    if (parsed.kind === 'invalid') {
        row.classList.add('jl-invalid');
        const badge = document.createElement('span');
        badge.className = 'jl-invalid-badge';
        badge.textContent = 'invalid JSON';
        badge.title = parsed.error;
        content.appendChild(badge);
        // Invalid lines stay as plain text — running a partial token
        // pass would mis-colour broken JSON and confuse the reader.
        content.appendChild(document.createTextNode(raw));
    } else if (parsed.kind === 'empty') {
        row.classList.add('jl-empty');
    } else {
        // Valid line — issue #61: render the raw text as a tokenised
        // sequence of coloured spans. We cache the produced children
        // as a DocumentFragment (cloned on each materialisation) so
        // re-rendering the same row never re-tokenises.
        const cached = state.fragments[index];
        if (cached) {
            content.appendChild(cached.cloneNode(true));
        } else {
            const fragment = buildHighlightedFragment(raw);
            // Snapshot the fragment for future re-mounts before we
            // hand it to the live row (appendChild would empty it).
            state.fragments[index] = fragment.cloneNode(true) as DocumentFragment;
            content.appendChild(fragment);
        }
    }
}

/**
 * Tokenise `raw` with the shared JSON tokenizer (#63) and return a
 * `DocumentFragment` whose children are one coloured `<span>` per
 * non-whitespace token, with whitespace preserved as plain text nodes
 * so the row visually mirrors the original input.
 *
 * Each non-whitespace token gets the class `jl-tok-{kind}` where
 * `kind` is one of: `key`, `string`, `number`, `bool`, `null`,
 * `punct`, `unknown`. The tokenizer never emits a separate token for
 * whitespace runs as a coloured class — they are intentionally
 * uncoloured to keep the highlighting cost proportional to "real"
 * tokens only.
 *
 * Exposed for testing — the JSONL viewer's row builder is the only
 * runtime caller, but the test suite for #61 mounts this helper
 * directly to assert the emitted classNames without spinning up the
 * full viewer shell.
 */
export function buildHighlightedFragment(raw: string): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const tokens = tokenizeJson(raw);
    appendTokensToFragment(fragment, tokens);
    return fragment;
}

function appendTokensToFragment(
    parent: DocumentFragment | HTMLElement,
    tokens: ReadonlyArray<JsonToken>
): void {
    for (const token of tokens) {
        if (token.kind === 'whitespace') {
            parent.appendChild(document.createTextNode(token.text));
            continue;
        }
        const span = document.createElement('span');
        span.className = `jl-tok-${token.kind}`;
        span.textContent = token.text;
        parent.appendChild(span);
    }
}

// ---------------------------------------------------------------------------
// Editor controller (issue #60).
// ---------------------------------------------------------------------------

interface EditorController {
    isEditing(): boolean;
    beginEdit(index: number, row: HTMLElement, mouseX: number, mouseY: number): void;
    cancel(): void;
    download(): void;
    dispose(): void;
}

/**
 * Wire the editor reducer to the popup DOM. The popup is reused as
 * the editor surface — when the user clicks a row we swap the popup's
 * `<pre>` body for a `<textarea>` + Save / Cancel buttons + an inline
 * error region, and bind input listeners to drive the reducer.
 */
function createEditorController(
    state: ViewerState,
    dom: ViewerDom,
    popup: PopupHandle,
    fileName: string
): EditorController {
    const popupEl = popup.element;
    let editorBox: HTMLDivElement | null = null;
    let textarea: HTMLTextAreaElement | null = null;
    let errorBox: HTMLDivElement | null = null;
    let badge: HTMLSpanElement | null = null;
    let saveBtn: HTMLButtonElement | null = null;
    let cancelBtn: HTMLButtonElement | null = null;
    let editingRow: HTMLElement | null = null;
    let lastObjectUrl: string | null = null;

    const onInput = () => {
        if (!textarea) return;
        dispatch({ type: 'updateDraft', text: textarea.value });
    };
    const onSave = () => {
        if (state.edit.editingIndex === null) return;
        if (state.edit.validation.kind !== 'valid') return;
        commitSave();
    };
    const onCancel = () => {
        cancelEdit();
    };
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onSave();
        }
    };

    function dispatch(action: EditAction): void {
        state.edit = reduce(state.edit, action);
        renderEditor();
    }

    function ensureEditorDom(): void {
        if (editorBox) return;
        // Take over the popup: pointer-events become live so the user
        // can interact with the textarea + buttons.
        popupEl.style.pointerEvents = 'auto';

        editorBox = document.createElement('div');
        editorBox.className = 'jl-edit-box';

        const header = document.createElement('div');
        header.className = 'jl-edit-header';
        const title = document.createElement('span');
        title.className = 'jl-edit-title';
        title.textContent = 'Edit row';
        badge = document.createElement('span');
        badge.className = 'jl-edit-badge';
        header.append(title, badge);

        textarea = document.createElement('textarea');
        textarea.className = 'jl-edit-textarea';
        textarea.spellcheck = false;
        textarea.setAttribute('aria-label', 'JSONL row editor');
        textarea.addEventListener('input', onInput);
        textarea.addEventListener('keydown', onKeyDown);

        errorBox = document.createElement('div');
        errorBox.className = 'jl-edit-error';
        errorBox.setAttribute('role', 'alert');

        const actions = document.createElement('div');
        actions.className = 'jl-edit-actions';
        saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'jl-edit-save';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', onSave);
        cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'jl-edit-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', onCancel);
        actions.append(cancelBtn, saveBtn);

        editorBox.append(header, textarea, errorBox, actions);
        popupEl.appendChild(editorBox);
    }

    function teardownEditorDom(): void {
        if (editorBox && editorBox.parentNode) {
            editorBox.parentNode.removeChild(editorBox);
        }
        if (textarea) {
            textarea.removeEventListener('input', onInput);
            textarea.removeEventListener('keydown', onKeyDown);
        }
        saveBtn?.removeEventListener('click', onSave);
        cancelBtn?.removeEventListener('click', onCancel);
        editorBox = null;
        textarea = null;
        errorBox = null;
        badge = null;
        saveBtn = null;
        cancelBtn = null;
        // `placePopupNear()` hides the preview while the editor owns the
        // popup. Restore it before any later hover: otherwise `show()`
        // correctly renders fresh tokens into a permanently display:none
        // `<pre>`, leaving an empty popup after Cancel/Save.
        const preview = popupEl.querySelector('pre');
        if (preview) (preview as HTMLElement).style.display = '';
        popupEl.style.pointerEvents = 'none';
    }

    function renderEditor(): void {
        if (state.edit.editingIndex === null) {
            teardownEditorDom();
            popupEl.style.display = 'none';
            popupEl.setAttribute('aria-hidden', 'true');
            return;
        }
        ensureEditorDom();
        if (!textarea || !errorBox || !badge || !saveBtn) return;
        // Avoid clobbering user caret if the textarea content already
        // matches the draft (e.g. when typing live).
        if (textarea.value !== state.edit.draft) {
            textarea.value = state.edit.draft;
        }
        const v = state.edit.validation;
        applyValidation(v, errorBox, badge, textarea);
        saveBtn.disabled = v.kind !== 'valid' || !isDirty(state.edit);
    }

    function applyValidation(
        v: JsonValidation,
        err: HTMLDivElement,
        badgeEl: HTMLSpanElement,
        ta: HTMLTextAreaElement
    ): void {
        if (v.kind === 'valid') {
            err.textContent = '';
            err.classList.remove('jl-edit-error-visible');
            badgeEl.textContent = 'valid';
            badgeEl.className = 'jl-edit-badge jl-edit-badge-valid';
            ta.classList.remove('jl-edit-textarea-invalid');
            ta.classList.add('jl-edit-textarea-valid');
        } else {
            err.textContent = `Line ${v.line}, col ${v.col}: ${v.message}`;
            err.classList.add('jl-edit-error-visible');
            badgeEl.textContent = 'invalid';
            badgeEl.className = 'jl-edit-badge jl-edit-badge-invalid';
            ta.classList.add('jl-edit-textarea-invalid');
            ta.classList.remove('jl-edit-textarea-valid');
        }
    }

    function commitSave(): void {
        const idx = state.edit.editingIndex;
        if (idx === null) return;
        const draft = state.edit.draft;
        // The editor intentionally presents valid JSON in a readable,
        // indented form. JSONL itself still requires exactly one physical
        // line per record, so canonicalise only at the persistence boundary.
        const serialized = JSON.stringify(JSON.parse(draft));
        // 1. Update the source-of-truth line + invalidate the cached
        //    fragment so the next render re-tokenises with the new
        //    text. (issue #60 step 3)
        state.lines[idx] = serialized;
        state.fragments[idx] = undefined;
        const newParsed = parseJsonlLine(serialized);
        state.parsed[idx] = newParsed;
        // 2. Drive the reducer through the save transition.
        dispatch({ type: 'updateDraft', text: serialized });
        dispatch({ type: 'save' });
        // 3. Re-render the row in place if it is still in the DOM.
        if (editingRow) {
            const content = editingRow.querySelector<HTMLSpanElement>('.jl-line-content');
            if (content) {
                populateRowContent(state, idx, serialized, newParsed, editingRow, content);
            }
        }
        editingRow = null;
        popup.hide();
    }

    function cancelEdit(): void {
        dispatch({ type: 'cancel' });
        editingRow = null;
        popup.hide();
    }

    function placePopupNear(mouseX: number, mouseY: number): void {
        // Reuse popup.show() with a placeholder string; the editor DOM
        // is positioned by the popup's existing clamp logic.
        popup.show('', mouseX, mouseY);
        // popup.show clears `display: none` and writes textContent on
        // the inner <pre>. We hide that <pre> while the editor DOM is
        // mounted so the popup body shows only the editor.
        const pre = popupEl.querySelector('pre');
        if (pre) (pre as HTMLElement).style.display = 'none';
    }

    function beginEdit(
        index: number,
        row: HTMLElement,
        mouseX: number,
        mouseY: number
    ): void {
        // If a different row is in edit mode and dirty, refuse to
        // hijack the popup — the user might lose work. We err on the
        // side of conservatism and just no-op the click.
        if (
            state.edit.editingIndex !== null &&
            state.edit.editingIndex !== index &&
            isDirty(state.edit)
        ) {
            return;
        }
        // Cancel any pending hover popup before we hijack the element.
        popup.cancelPending();
        editingRow = row;
        const original = state.lines[index] ?? '';
        const parsed = state.parsed[index] ?? parseJsonlLine(original);
        // Valid records open as pretty JSON; malformed lines keep their raw
        // text so the user can repair them without losing information.
        const draft = parsed.kind === 'valid' ? parsed.formatted : original;
        dispatch({ type: 'beginEdit', index, original: draft });
        placePopupNear(mouseX, mouseY);
        if (textarea) {
            textarea.focus();
            // Place caret at end so the user can append immediately.
            try {
                textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            } catch {
                /* ignore — older jsdom builds throw on detached nodes */
            }
        }
    }

    function download(): void {
        const text = assembleJsonl(state.lines, state.edit.edits);
        const blob = new Blob([text], { type: 'application/x-ndjson' });
        const doc = popupEl.ownerDocument ?? document;
        const url = doc.defaultView && 'URL' in doc.defaultView
            ? (doc.defaultView as unknown as { URL: typeof URL }).URL.createObjectURL(blob)
            : URL.createObjectURL(blob);
        if (lastObjectUrl) {
            try {
                URL.revokeObjectURL(lastObjectUrl);
            } catch {
                /* ignore */
            }
        }
        lastObjectUrl = url;
        const a = doc.createElement('a');
        a.href = url;
        a.download = downloadFilename(fileName);
        a.style.display = 'none';
        doc.body.appendChild(a);
        a.click();
        doc.body.removeChild(a);
    }

    function dispose(): void {
        teardownEditorDom();
        if (lastObjectUrl) {
            try {
                URL.revokeObjectURL(lastObjectUrl);
            } catch {
                /* ignore */
            }
            lastObjectUrl = null;
        }
    }

    return {
        isEditing: () => state.edit.editingIndex !== null,
        beginEdit,
        cancel: cancelEdit,
        download,
        dispose
    };
}

/** Derive a sensible filename for the downloaded JSONL. */
function downloadFilename(original: string): string {
    if (!original) return 'edited.jsonl';
    // Strip a trailing extension and append `.edited.jsonl`. We keep
    // the original extension's case so the download mirrors what the
    // user opened.
    const dot = original.lastIndexOf('.');
    if (dot <= 0) return `${original}.edited.jsonl`;
    const stem = original.slice(0, dot);
    const ext = original.slice(dot);
    return `${stem}.edited${ext}`;
}

function updateInfo(state: ViewerState, dom: ViewerDom): void {
    const total = state.lines.length;
    const rendered = state.rendered;
    if (total === rendered) {
        dom.info.textContent = `${total} line${total === 1 ? '' : 's'}`;
        dom.loadMoreBtn.style.display = 'none';
    } else {
        dom.info.textContent = `${rendered.toLocaleString()} of ${total.toLocaleString()} lines`;
        dom.loadMoreBtn.style.display = '';
        const next = Math.min(LOAD_MORE_BATCH_SIZE, total - rendered);
        dom.loadMoreBtn.textContent = `Load ${next.toLocaleString()} more`;
    }
}

// Re-export pure helpers for tests + composition.
export { parseJsonlLine, splitJsonlLines, attachPopup };
export type { ParsedLine, PopupHandle };
export {
    assembleJsonl,
    initialEditState,
    isDirty,
    reduce as reduceEdit
} from './jsonlEditor';
export type { EditAction, EditState, JsonValidation } from './jsonlEditor';
