// Orchestration layer for the JSON viewer (issue #62).
//
// Responsibilities (the file is intentionally the "impure" half of the
// viewer; all data-only logic lives in `./jsonTree.ts`):
//
//   1. Read the file with `await file.text()`, parse with `JSON.parse`.
//      On parse error, render a friendly error panel inside the viewer.
//   2. Build a `TreeNode` graph and lazily render it into the DOM. Only
//      EXPANDED containers materialize their children; collapsed
//      containers carry a single placeholder `<div data-jv-stub>` and
//      are populated on first expand. This keeps a 10MB JSON snappy
//      because the user pays the DOM cost only for paths they explore.
//   3. Wire the search input + keyboard shortcuts:
//        - typing in the search box runs `search`, highlights matches,
//          and auto-expands their ancestors via `expandAncestorsOf`.
//        - `Ctrl/Cmd + F` focuses the search input.
//        - `Enter` (or `n`) jumps to the next match; `Shift + Enter`
//          (or `N`) jumps to the previous match. The "current" match
//          gets the `jv-current` class and is scrolled into view.
//
// All shortcuts are scoped to the viewer container. We do NOT capture
// global keyboard events while the viewer is unmounted.

import {
    TreeNode,
    JsonValueKind,
    buildTree,
    expand,
    collapse,
    toggle,
    expandAncestorsOf,
    isContainer,
    search,
    nextMatchIndex,
    prevMatchIndex,
    walk
} from './jsonTree';
import { JSON_VIEWER_CSS } from './jsonViewerStyles';
import { tokenizeJson, JsonToken } from './jsonTokenizer';

const STYLE_ELEMENT_ID = 'omni-viewer-json-styles';

export interface JsonViewerHandle {
    dispose(): void;
}

interface ViewerDom {
    root: HTMLElement;
    toolbar: HTMLElement;
    searchInput: HTMLInputElement;
    matchInfo: HTMLElement;
    prevButton: HTMLButtonElement;
    nextButton: HTMLButtonElement;
    treeButton: HTMLButtonElement;
    sourceButton: HTMLButtonElement;
    treeHost: HTMLElement;
    sourceHost: HTMLElement;
    actions: HTMLElement;
    resultPanel: HTMLElement;
    resultOutput: HTMLPreElement;
    copyResultButton: HTMLButtonElement;
    closeResultButton: HTMLButtonElement;
    editor: HTMLTextAreaElement;
    status: HTMLElement;
}

type ViewerMode = 'tree' | 'source';

interface ViewerState {
    tree: TreeNode | null;
    /** Raw text contents of the file (used by source mode). */
    rawText: string;
    /** Map from TreeNode → its DOM row element (when materialized). */
    rowElements: WeakMap<TreeNode, HTMLElement>;
    /** Map from TreeNode → its children-container element (when materialized). */
    childContainers: WeakMap<TreeNode, HTMLElement>;
    /** Flat list of currently matching nodes (in DFS order). */
    matches: TreeNode[];
    /** Index into `matches`; -1 when there is no active match. */
    currentMatchIndex: number;
    /** Currently displayed view mode. */
    mode: ViewerMode;
    /** True after the source view has been built once. */
    sourceRendered: boolean;
}

/**
 * Inject the runtime CSS once per document. Mirrors the pattern used by
 * imageViewerMain / pdfViewerMain — the legacy SPA host page does not
 * load `templates/json/css/jsonViewer.css`, so we self-inject.
 */
function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = JSON_VIEWER_CSS;
    document.head.appendChild(style);
}

/**
 * Mount the JSON viewer into `container`. Returns a handle whose
 * `dispose()` clears the container and removes any global listeners
 * that the viewer attached.
 */
export async function mountJsonViewer(
    file: File,
    container: HTMLElement
): Promise<JsonViewerHandle> {
    ensureStylesInjected();
    container.innerHTML = '';
    container.classList.add('jv-host');

    const dom = buildShell(container, file.name);
    const state: ViewerState = {
        tree: null,
        rawText: '',
        rowElements: new WeakMap(),
        childContainers: new WeakMap(),
        matches: [],
        currentMatchIndex: -1,
        mode: 'source',
        sourceRendered: false
    };

    // Read & parse. Surface a friendly error if parsing fails.
    let parsed: unknown;
    let rawText = '';
    let parseFailed = false;
    try {
        rawText = await file.text();
        state.rawText = rawText;
        dom.editor.value = rawText;
        try {
            parsed = JSON.parse(rawText);
        } catch (parseErr) {
            const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
            renderError(dom.treeHost, `Failed to parse JSON: ${message}`);
            parseFailed = true;
            // We can still render source mode with the raw text below, so
            // the user can at least see the syntax-highlighted bytes.
        }
    } catch (readErr) {
        const message = readErr instanceof Error ? readErr.message : String(readErr);
        renderError(dom.treeHost, `Failed to read file: ${message}`);
        return makeHandle(container, dom, () => {});
    }

    if (!parseFailed) {
        state.tree = buildTree(parsed);
        renderTree(state, dom);
    } else {
        // Disable tree-only controls when there is no tree to render.
        dom.searchInput.disabled = true;
        dom.prevButton.disabled = true;
        dom.nextButton.disabled = true;
    }

    const showResult = (title: string, value: string) => {
        dom.resultPanel.style.display = 'block';
        dom.resultPanel.querySelector<HTMLElement>('.jv-result-title')!.textContent = title;
        dom.resultOutput.textContent = value;
    };
    const onAction = (event: Event) => {
        const action = (event.target as Element).closest<HTMLButtonElement>('[data-json-action]')?.dataset.jsonAction;
        if (!action) return;
        try {
            const currentText = dom.editor.value;
            const input = JSON.parse(currentText);
            if (action === 'pretty') showResult('Pretty JSON', JSON.stringify(input, null, 2));
            else if (action === 'minify') showResult('Minified JSON', JSON.stringify(input));
            else if (action === 'sort') showResult('Sorted JSON', JSON.stringify(sortJsonKeys(input), null, 2));
            else if (action === 'validate') showResult('Validation', parseFailed ? 'Invalid JSON' : 'Valid JSON');
            else if (action === 'csv') showResult('JSON to CSV', jsonToCsv(input));
            else if (action === 'xml') showResult('JSON to XML', jsonToXml(input));
            else if (action === 'yaml') showResult('JSON to YAML', jsonToYaml(input));
            else if (action === 'escape') showResult('Escaped', JSON.stringify(currentText));
            else if (action === 'unescape') showResult('Unescaped', String(JSON.parse(currentText)));
            else if (action === 'base64-encode') showResult('Base64 Encoded', bytesToBase64(new TextEncoder().encode(currentText)));
            else if (action === 'base64-decode') showResult('Base64 Decoded', new TextDecoder().decode(base64ToBytes(currentText.trim())));
        } catch (error) {
            showResult('Error', error instanceof Error ? error.message : String(error));
        }
    };
    const onCopyResult = () => { void navigator.clipboard?.writeText(dom.resultOutput.textContent || ''); };
    const onCloseResult = () => { dom.resultPanel.style.display = 'none'; };
    dom.actions.addEventListener('click', onAction);
    dom.copyResultButton.addEventListener('click', onCopyResult);
    dom.closeResultButton.addEventListener('click', onCloseResult);

    const cleanups: Array<() => void> = [];
    cleanups.push(() => dom.actions.removeEventListener('click', onAction));
    cleanups.push(() => dom.copyResultButton.removeEventListener('click', onCopyResult));
    cleanups.push(() => dom.closeResultButton.removeEventListener('click', onCloseResult));
    const onEditorInput = () => {
        state.rawText = dom.editor.value;
        state.sourceRendered = false;
        try {
            parsed = JSON.parse(state.rawText);
            state.tree = buildTree(parsed);
            state.rowElements = new WeakMap();
            state.childContainers = new WeakMap();
            renderTree(state, dom);
            renderSource(state, dom);
            dom.status.textContent = 'Valid';
            dom.status.className = 'jv-status is-valid';
        } catch {
            dom.status.textContent = 'Invalid';
            dom.status.className = 'jv-status is-invalid';
        }
    };
    dom.editor.addEventListener('input', onEditorInput);
    cleanups.push(() => dom.editor.removeEventListener('input', onEditorInput));

    // Search input.
    const onInput = () => {
        runSearch(state, dom, dom.searchInput.value);
    };
    dom.searchInput.addEventListener('input', onInput);
    cleanups.push(() => dom.searchInput.removeEventListener('input', onInput));

    const onKey = (event: KeyboardEvent) => {
        handleSearchKey(event, state, dom);
    };
    dom.searchInput.addEventListener('keydown', onKey);
    cleanups.push(() => dom.searchInput.removeEventListener('keydown', onKey));

    // Container-scoped shortcuts (Ctrl/Cmd+F to focus search, n / N
    // outside the input).
    const onContainerKey = (event: KeyboardEvent) => {
        handleContainerKey(event, state, dom);
    };
    container.addEventListener('keydown', onContainerKey);
    cleanups.push(() => container.removeEventListener('keydown', onContainerKey));

    // Make the container focusable so it actually receives key events.
    if (!container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '0');
    }

    // Prev/next match buttons.
    const onPrev = () => stepMatch(state, dom, -1);
    const onNext = () => stepMatch(state, dom, 1);
    dom.prevButton.addEventListener('click', onPrev);
    dom.nextButton.addEventListener('click', onNext);
    cleanups.push(() => {
        dom.prevButton.removeEventListener('click', onPrev);
        dom.nextButton.removeEventListener('click', onNext);
    });

    // Tree / Source mode toggle.
    const onTree = () => switchMode(state, dom, 'tree');
    const onSource = () => switchMode(state, dom, 'source');
    dom.treeButton.addEventListener('click', onTree);
    dom.sourceButton.addEventListener('click', onSource);
    cleanups.push(() => {
        dom.treeButton.removeEventListener('click', onTree);
        dom.sourceButton.removeEventListener('click', onSource);
    });
    switchMode(state, dom, 'source');

    updateMatchInfo(state, dom);

    return makeHandle(container, dom, () => {
        for (const c of cleanups) c();
    });
}

function makeHandle(
    container: HTMLElement,
    _dom: ViewerDom,
    cleanup: () => void
): JsonViewerHandle {
    return {
        dispose() {
            cleanup();
            container.innerHTML = '';
            container.classList.remove('jv-host');
        }
    };
}

// ---------------------------------------------------------------------------
// Shell DOM.
// ---------------------------------------------------------------------------

function buildShell(container: HTMLElement, fileName: string): ViewerDom {
    const root = document.createElement('div');
    root.className = 'jv-container';

    const header = document.createElement('header'); header.className = 'jv-header';
    const heading = document.createElement('div');
    const title = document.createElement('div'); title.className = 'jv-title'; title.textContent = fileName;
    const subtitle = document.createElement('div'); subtitle.className = 'jv-subtitle'; subtitle.textContent = 'Inspect, validate, transform, and convert JSON';
    heading.append(title, subtitle);
    const status = document.createElement('div'); status.className = 'jv-status'; status.textContent = 'Ready';
    header.append(heading, status);

    const toolbar = document.createElement('div');
    toolbar.className = 'jv-toolbar';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'jv-search';
    searchInput.placeholder = 'Search keys / values  (Ctrl+F to focus, Enter / Shift+Enter to step)';
    searchInput.setAttribute('aria-label', 'Search JSON keys and values');

    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'jv-button';
    prevButton.textContent = 'Prev';
    prevButton.title = 'Previous match (Shift+Enter / N)';

    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'jv-button';
    nextButton.textContent = 'Next';
    nextButton.title = 'Next match (Enter / N)';

    const matchInfo = document.createElement('span');
    matchInfo.className = 'jv-match-info';
    matchInfo.textContent = '';

    const modeGroup = document.createElement('div');
    modeGroup.className = 'jv-mode-group';

    const treeButton = document.createElement('button');
    treeButton.type = 'button';
    treeButton.className = 'jv-button jv-mode-button';
    treeButton.textContent = 'Tree View';
    treeButton.title = 'Tree view';

    const sourceButton = document.createElement('button');
    sourceButton.type = 'button';
    sourceButton.className = 'jv-button jv-mode-button';
    sourceButton.textContent = 'Text View';
    sourceButton.title = 'Syntax-highlighted source';

    modeGroup.append(sourceButton, treeButton);

    toolbar.append(modeGroup);

    const actions = document.createElement('div');
    actions.className = 'jv-actions';
    const actionItems: Array<[string, string]> = [
        ['pretty', 'Pretty'], ['minify', 'Minify'], ['sort', 'Sort Keys'], ['validate', 'Validate'],
        ['csv', 'JSON to CSV'], ['xml', 'JSON to XML'], ['yaml', 'JSON to YAML'],
        ['escape', 'Escape'], ['unescape', 'Unescape'], ['base64-encode', 'Base64 Encode'], ['base64-decode', 'Base64 Decode']
    ];
    actionItems.forEach(([action, label], index) => { if (index === 0 || index === 4 || index === 7) { const group = document.createElement('div'); group.className = 'jv-action-group'; actions.appendChild(group); } const button = document.createElement('button'); button.type = 'button'; button.className = 'jv-button'; button.dataset.jsonAction = action; button.textContent = label; actions.lastElementChild!.appendChild(button); });

    const treeHost = document.createElement('div');
    treeHost.className = 'jv-tree';

    const sourceHost = document.createElement('div');
    sourceHost.className = 'jv-source';
    sourceHost.style.display = 'none';

    const resultPanel = document.createElement('section');
    resultPanel.className = 'jv-result'; resultPanel.style.display = 'none';
    const resultHeader = document.createElement('div'); resultHeader.className = 'jv-result-header';
    const resultTitle = document.createElement('strong'); resultTitle.className = 'jv-result-title';
    const resultActions = document.createElement('div'); resultActions.className = 'jv-result-actions';
    const copyResultButton = document.createElement('button'); copyResultButton.type = 'button'; copyResultButton.className = 'jv-button'; copyResultButton.textContent = 'Copy';
    const closeResultButton = document.createElement('button'); closeResultButton.type = 'button'; closeResultButton.className = 'jv-button'; closeResultButton.textContent = 'Close';
    resultActions.append(copyResultButton, closeResultButton); resultHeader.append(resultTitle, resultActions);
    const resultOutput = document.createElement('pre'); resultOutput.className = 'jv-result-output';
    resultPanel.append(resultHeader, resultOutput);

    const workspace = document.createElement('main'); workspace.className = 'jv-workspace';
    const editorPanel = document.createElement('section'); editorPanel.className = 'jv-panel'; editorPanel.innerHTML = '<div class="jv-panel-header"><span>Editor</span><span>Edit source text and apply actions</span></div>';
    const editor = document.createElement('textarea'); editor.className = 'jv-editor'; editor.spellcheck = false; editorPanel.appendChild(editor);
    const previewPanel = document.createElement('section'); previewPanel.className = 'jv-panel'; previewPanel.innerHTML = '<div class="jv-panel-header"><span>Preview</span><span>Syntax highlighted JSON</span></div>';
    const searchBar = document.createElement('div'); searchBar.className = 'jv-search-bar'; searchBar.append(searchInput, prevButton, nextButton, matchInfo);
    previewPanel.append(searchBar, treeHost, sourceHost); workspace.append(editorPanel, previewPanel);
    root.append(header, toolbar, actions, resultPanel, workspace);
    container.appendChild(root);

    return {
        root,
        toolbar,
        searchInput,
        matchInfo,
        prevButton,
        nextButton,
        treeButton,
        sourceButton,
        treeHost,
        sourceHost,
        actions, resultPanel, resultOutput, copyResultButton, closeResultButton, editor, status
    };
}

function sortJsonKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJsonKeys);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJsonKeys(child)]));
    return value;
}

function jsonToCsv(value: unknown): string {
    const rows = Array.isArray(value) ? value : [value];
    const objects = rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
    const headers = Array.from(new Set(objects.flatMap((row) => Object.keys(row))));
    const quote = (cell: unknown) => `"${String(cell ?? '').replace(/"/g, '""')}"`;
    return [headers.map(quote).join(','), ...objects.map((row) => headers.map((header) => quote(row[header])).join(','))].join('\n');
}

function jsonToXml(value: unknown, name = 'root'): string {
    if (Array.isArray(value)) return `<${name}>${value.map((item) => jsonToXml(item, 'item')).join('')}</${name}>`;
    if (value && typeof value === 'object') return `<${name}>${Object.entries(value as Record<string, unknown>).map(([key, child]) => jsonToXml(child, key.replace(/[^\w.-]/g, '_'))).join('')}</${name}>`;
    return `<${name}>${escapeXml(String(value ?? ''))}</${name}>`;
}

function jsonToYaml(value: unknown, depth = 0): string {
    const indent = '  '.repeat(depth);
    if (Array.isArray(value)) return value.map((item) => `${indent}- ${isScalar(item) ? yamlScalar(item) : `\n${jsonToYaml(item, depth + 1)}`}`).join('\n');
    if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).map(([key, child]) => `${indent}${key}: ${isScalar(child) ? yamlScalar(child) : `\n${jsonToYaml(child, depth + 1)}`}`).join('\n');
    return `${indent}${yamlScalar(value)}`;
}
function isScalar(value: unknown): boolean { return value == null || typeof value !== 'object'; }
function yamlScalar(value: unknown): string { return typeof value === 'string' ? JSON.stringify(value) : String(value); }
function escapeXml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!)); }
function bytesToBase64(bytes: Uint8Array): string { let binary = ''; bytes.forEach((byte) => { binary += String.fromCharCode(byte); }); return btoa(binary); }
function base64ToBytes(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }

function renderError(treeHost: HTMLElement, message: string): void {
    treeHost.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'jv-error';
    err.setAttribute('role', 'alert');
    err.textContent = message;
    treeHost.appendChild(err);
}

// ---------------------------------------------------------------------------
// Tree rendering (lazy).
// ---------------------------------------------------------------------------

function renderTree(state: ViewerState, dom: ViewerDom): void {
    dom.treeHost.innerHTML = '';
    if (!state.tree) return;
    const rootEl = renderNode(state, state.tree);
    dom.treeHost.appendChild(rootEl);
}

/**
 * Render a single node + (if expanded) its children. The returned
 * element is a `<div class="jv-node">` that owns the row and the
 * children container.
 */
function renderNode(state: ViewerState, node: TreeNode): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'jv-node';

    const row = document.createElement('div');
    row.className = 'jv-row';
    if (isContainer(node)) {
        row.classList.add('jv-toggleable');
    }
    state.rowElements.set(node, row);

    const toggleEl = document.createElement('span');
    toggleEl.className = 'jv-toggle';
    if (!isContainer(node)) {
        toggleEl.classList.add('jv-leaf');
    }
    updateToggleGlyph(toggleEl, node);
    row.appendChild(toggleEl);

    const keyEl = document.createElement('span');
    keyEl.className = 'jv-key';
    if (node.parent && node.parent.kind === 'array') {
        keyEl.classList.add('jv-array-index');
    }
    keyEl.textContent = node.key;
    row.appendChild(keyEl);

    const colon = document.createElement('span');
    colon.className = 'jv-colon';
    colon.textContent = ':';
    row.appendChild(colon);

    if (isContainer(node)) {
        const summary = document.createElement('span');
        summary.className = 'jv-summary';
        summary.textContent = containerSummary(node);
        row.appendChild(summary);
    } else {
        const value = document.createElement('span');
        value.className = `jv-value jv-value-${node.kind}`;
        value.textContent = node.primitive ?? '';
        row.appendChild(value);
    }

    applyMatchClass(row, node);

    if (isContainer(node)) {
        row.addEventListener('click', () => {
            const nowExpanded = toggle(node);
            updateToggleGlyph(toggleEl, node);
            const childContainer = state.childContainers.get(node);
            if (childContainer) {
                childContainer.style.display = nowExpanded ? '' : 'none';
                if (nowExpanded) {
                    materializeChildrenIfNeeded(state, node, childContainer);
                }
            }
        });
    }

    wrap.appendChild(row);

    if (isContainer(node)) {
        const childContainer = document.createElement('div');
        childContainer.className = 'jv-children';
        childContainer.style.display = node.expanded ? '' : 'none';
        state.childContainers.set(node, childContainer);
        if (node.expanded) {
            materializeChildrenIfNeeded(state, node, childContainer);
        }
        wrap.appendChild(childContainer);
    }

    return wrap;
}

/**
 * Build the actual child <jv-node> elements the first time we need them.
 * Subsequent expand/collapse just toggles the container's `display`.
 *
 * The "first expand" gate is the key to keeping 10MB JSON smooth: deep
 * subtrees that the user never opens are NEVER serialized into DOM.
 */
function materializeChildrenIfNeeded(
    state: ViewerState,
    node: TreeNode,
    container: HTMLElement
): void {
    if (!node.children) return;
    if (container.dataset.jvMaterialized === '1') return;
    container.dataset.jvMaterialized = '1';
    const frag = document.createDocumentFragment();
    for (const child of node.children) {
        frag.appendChild(renderNode(state, child));
    }
    container.appendChild(frag);
}

function updateToggleGlyph(el: HTMLElement, node: TreeNode): void {
    if (!isContainer(node)) {
        el.textContent = '';
        return;
    }
    el.textContent = node.expanded ? '▼' : '▶'; // ▼ / ▶
}

function containerSummary(node: TreeNode): string {
    const count = node.children?.length ?? 0;
    if (node.kind === 'array') {
        return `Array(${count})`;
    }
    return `Object{${count}}`;
}

function applyMatchClass(row: HTMLElement, node: TreeNode): void {
    if (node.matched) {
        row.classList.add('jv-match-highlight');
    } else {
        row.classList.remove('jv-match-highlight');
    }
}

// ---------------------------------------------------------------------------
// Source mode rendering.
// ---------------------------------------------------------------------------

/**
 * Switch the viewer between tree and source mode. Source mode is
 * lazy-rendered on first activation so the tokenizer cost only
 * applies when the user actually asks for it.
 */
function switchMode(state: ViewerState, dom: ViewerDom, mode: ViewerMode): void {
    if (state.mode === mode) return;
    state.mode = mode;
    if (mode === 'source') {
        if (!state.sourceRendered) {
            renderSource(state, dom);
            state.sourceRendered = true;
        }
        dom.treeHost.style.display = 'none';
        dom.sourceHost.style.display = '';
    } else {
        dom.sourceHost.style.display = 'none';
        dom.treeHost.style.display = '';
    }
    updateModeButtons(state, dom);
}

function updateModeButtons(state: ViewerState, dom: ViewerDom): void {
    dom.treeButton.classList.toggle('jv-mode-active', state.mode === 'tree');
    dom.sourceButton.classList.toggle('jv-mode-active', state.mode === 'source');
}

/**
 * Tokenize `state.rawText` and emit one `<span class="jv-tok-...">`
 * per non-whitespace token (whitespace is appended as plain text so
 * the host `<pre>` preserves layout without bloating the DOM).
 */
function renderSource(state: ViewerState, dom: ViewerDom): void {
    dom.sourceHost.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'jv-source-pre';
    const code = document.createElement('code');
    code.className = 'jv-source-code';
    appendTokens(code, tokenizeJson(state.rawText));
    pre.appendChild(code);
    dom.sourceHost.appendChild(pre);
}

/**
 * Append tokens to `parent` as a sequence of `<span>` elements (one
 * per coloured token) plus plain text nodes for whitespace. Exposed
 * for testing and reuse by the JSONL viewer (#61).
 */
export function appendTokens(parent: HTMLElement, tokens: ReadonlyArray<JsonToken>): void {
    for (const token of tokens) {
        if (token.kind === 'whitespace') {
            parent.appendChild(document.createTextNode(token.text));
            continue;
        }
        const span = document.createElement('span');
        span.className = `jv-tok-${token.kind}`;
        span.textContent = token.text;
        parent.appendChild(span);
    }
}

// ---------------------------------------------------------------------------
// Search wiring.
// ---------------------------------------------------------------------------

function runSearch(state: ViewerState, dom: ViewerDom, query: string): void {
    if (!state.tree) return;

    // Clear `current` styling on the previously-current match.
    const prevCurrent = state.matches[state.currentMatchIndex];
    if (prevCurrent) {
        const prevRow = state.rowElements.get(prevCurrent);
        prevRow?.classList.remove('jv-current');
    }

    // Snapshot all rows that previously had highlight, so we can clear them
    // even after `search` has reset their `matched` flag.
    const prevMatches = state.matches;

    const result = search(state.tree, query);
    state.matches = result.matches;

    // Drop highlight from previous matches that are no longer matches.
    for (const oldMatch of prevMatches) {
        const row = state.rowElements.get(oldMatch);
        if (row) applyMatchClass(row, oldMatch);
    }

    // Auto-expand ancestors so the matches become visible. For each
    // newly-expanded container, materialize its children + sync the
    // toggle glyph and child-container display.
    if (result.matches.length > 0) {
        const changed = expandAncestorsOf(result.matches);
        for (const ancestor of changed) {
            syncExpandedDom(state, ancestor);
        }
    }

    // Apply highlight to current matches; some of them may have been
    // first materialized just now via the ancestor-expand pass.
    for (const m of result.matches) {
        const row = state.rowElements.get(m);
        if (row) applyMatchClass(row, m);
    }

    state.currentMatchIndex = result.matches.length > 0 ? 0 : -1;
    if (state.currentMatchIndex >= 0) {
        focusMatch(state, dom, state.currentMatchIndex);
    }
    updateMatchInfo(state, dom);
}

/**
 * Sync a node's DOM after its `expanded` flag was changed by something
 * other than the user click handler (e.g. `expandAncestorsOf`).
 */
function syncExpandedDom(state: ViewerState, node: TreeNode): void {
    const row = state.rowElements.get(node);
    if (row) {
        const toggleEl = row.querySelector<HTMLElement>('.jv-toggle');
        if (toggleEl) updateToggleGlyph(toggleEl, node);
    }
    const childContainer = state.childContainers.get(node);
    if (childContainer) {
        childContainer.style.display = node.expanded ? '' : 'none';
        if (node.expanded) {
            materializeChildrenIfNeeded(state, node, childContainer);
        }
    }
}

function focusMatch(state: ViewerState, dom: ViewerDom, index: number): void {
    const target = state.matches[index];
    if (!target) return;
    const row = state.rowElements.get(target);
    if (!row) return;
    // Drop `jv-current` from any other row currently flagged.
    dom.treeHost.querySelectorAll('.jv-current').forEach((el) => {
        el.classList.remove('jv-current');
    });
    row.classList.add('jv-current');
    if (typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
}

function stepMatch(state: ViewerState, dom: ViewerDom, direction: 1 | -1): void {
    if (state.matches.length === 0) return;
    const next =
        direction === 1
            ? nextMatchIndex(state.currentMatchIndex, state.matches.length)
            : prevMatchIndex(state.currentMatchIndex, state.matches.length);
    state.currentMatchIndex = next;
    focusMatch(state, dom, next);
    updateMatchInfo(state, dom);
}

function updateMatchInfo(state: ViewerState, dom: ViewerDom): void {
    const total = state.matches.length;
    if (total === 0) {
        dom.matchInfo.textContent = dom.searchInput.value.trim() ? '0 matches' : '';
        dom.prevButton.disabled = true;
        dom.nextButton.disabled = true;
        return;
    }
    dom.matchInfo.textContent = `${state.currentMatchIndex + 1} / ${total}`;
    dom.prevButton.disabled = false;
    dom.nextButton.disabled = false;
}

function handleSearchKey(
    event: KeyboardEvent,
    state: ViewerState,
    dom: ViewerDom
): void {
    if (event.key === 'Enter') {
        event.preventDefault();
        stepMatch(state, dom, event.shiftKey ? -1 : 1);
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        dom.searchInput.value = '';
        runSearch(state, dom, '');
    }
}

function handleContainerKey(
    event: KeyboardEvent,
    state: ViewerState,
    dom: ViewerDom
): void {
    // Ctrl/Cmd + F: focus the search input.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        dom.searchInput.focus();
        dom.searchInput.select();
        return;
    }

    // `n` / `N` step matches when the search input does NOT have focus.
    if (document.activeElement === dom.searchInput) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key === 'n') {
        event.preventDefault();
        stepMatch(state, dom, 1);
    } else if (event.key === 'N') {
        event.preventDefault();
        stepMatch(state, dom, -1);
    }
}

// Re-export pure helpers for tests + composition.
export {
    buildTree,
    expand,
    collapse,
    toggle,
    expandAncestorsOf,
    isContainer,
    walk,
    search,
    nextMatchIndex,
    prevMatchIndex
};
export type { TreeNode, JsonValueKind };
