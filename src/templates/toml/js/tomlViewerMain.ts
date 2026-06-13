// TOML viewer orchestration (issue #65).
//
// Owns the DOM shell, tree rendering, raw-source toggle, search, and
// expand/collapse state. The pure parser lives in `src/utils/tomlParser.ts`;
// this module is the thin presentation layer around it.
//
// The exported `mountTomlViewer(file, container)` factory mirrors the shape
// of `mountCsvViewer` so the viewer registry can call it through the
// `ChromeViewerProvider.render` interface without any extra glue.

import {
    parseToml,
    parseTomlAst,
    TomlAstNode,
    TomlParseError,
    TomlValueType
} from '../../../utils/tomlParser';
import { ensureTomlViewerStyles } from './tomlViewerStyles';
import { tokenizeTomlSource } from '../../../utils/configSourceTokenizer';

export interface TomlViewerHandle {
    dispose(): void;
}

type ViewMode = 'tree' | 'raw' | 'flatten' | 'json';

interface ShellRefs {
    root: HTMLElement;
    title: HTMLElement;
    fileInfo: HTMLElement;
    search: HTMLInputElement;
    treeButton: HTMLButtonElement;
    rawButton: HTMLButtonElement;
    flattenButton: HTMLButtonElement;
    jsonButton: HTMLButtonElement;
    copyJsonButton: HTMLButtonElement;
    expandButton: HTMLButtonElement;
    collapseButton: HTMLButtonElement;
    body: HTMLElement;
    treePane: HTMLElement;
    rawPane: HTMLPreElement;
    outputPane: HTMLPreElement;
    error: HTMLElement;
    loading: HTMLElement;
}

interface ViewState {
    mode: ViewMode;
    ast: TomlAstNode | null;
    /** Map from a stable node-id (its tree path) to its expand state. */
    expanded: Map<string, boolean>;
    /** Last applied search query (lowercased). Empty string = no search. */
    query: string;
}

/**
 * Public entry. Reads the file, parses it, renders the tree, and wires up
 * controls. Returns a handle whose `dispose()` clears the container.
 */
export async function mountTomlViewer(
    file: File,
    container: HTMLElement
): Promise<TomlViewerHandle> {
    ensureTomlViewerStyles();
    container.innerHTML = '';
    container.classList.add('toml-viewer-host');

    const shell = buildShell(container, file.name);
    showLoading(shell, true);

    const state: ViewState = {
        mode: 'tree',
        ast: null,
        expanded: new Map(),
        query: ''
    };

    let rawText = '';
    try {
        rawText = await file.text();
        state.ast = parseTomlAst(rawText);
        // Default to expanding only the top level so big files don't blast
        // a 10k-line tree on first paint.
        seedExpansion(state, state.ast);
    } catch (err) {
        showLoading(shell, false);
        const message =
            err instanceof TomlParseError
                ? err.message
                : err instanceof Error
                    ? err.message
                    : String(err);
        showError(shell, `Failed to parse TOML: ${message}`);
        // Even on parse failure we expose the raw source so users can fix
        // the file in-place.
        renderHighlightedRaw(shell.rawPane, rawText);
        shell.rawPane.style.display = 'block';
        shell.treePane.style.display = 'none';
        shell.treeButton.disabled = true;
        return makeDisposeHandle(container);
    }

    renderHighlightedRaw(shell.rawPane, rawText);
    const parsedValue = parseToml(rawText);
    updateFileInfo(shell, file, rawText);

    showLoading(shell, false);
    renderTree(shell, state);

    // ----- Wire controls --------------------------------------------------

    shell.treeButton.addEventListener('click', () => {
        setMode(shell, state, 'tree');
    });
    shell.rawButton.addEventListener('click', () => {
        setMode(shell, state, 'raw');
    });
    shell.flattenButton.addEventListener('click', () => {
        shell.outputPane.textContent = flattenValue(parsedValue).map(([path, value]) => `${path} = ${formatFlatValue(value)}`).join('\n');
        setMode(shell, state, 'flatten');
    });
    shell.jsonButton.addEventListener('click', () => {
        shell.outputPane.textContent = JSON.stringify(parsedValue, null, 2);
        setMode(shell, state, 'json');
    });
    shell.copyJsonButton.addEventListener('click', () => { void navigator.clipboard?.writeText(JSON.stringify(parsedValue, null, 2)); });
    shell.expandButton.addEventListener('click', () => {
        if (!state.ast) return;
        setAllExpanded(state, state.ast, true);
        renderTree(shell, state);
    });
    shell.collapseButton.addEventListener('click', () => {
        if (!state.ast) return;
        setAllExpanded(state, state.ast, false);
        // Keep the root expanded so the user always sees the top level.
        state.expanded.set(rootId(), true);
        renderTree(shell, state);
    });

    let searchDebounce: ReturnType<typeof setTimeout> | null = null;
    shell.search.addEventListener('input', () => {
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            state.query = shell.search.value.trim().toLowerCase();
            renderTree(shell, state);
        }, 80);
    });

    return makeDisposeHandle(container);
}

function renderHighlightedRaw(host: HTMLElement, source: string): void {
    const fragment = document.createDocumentFragment();
    for (const token of tokenizeTomlSource(source)) {
        if (!token.kind) {
            fragment.appendChild(document.createTextNode(token.text));
            continue;
        }
        const span = document.createElement('span');
        span.className = `toml-raw-token-${token.kind}`;
        span.textContent = token.text;
        fragment.appendChild(span);
    }
    host.replaceChildren(fragment);
}

function makeDisposeHandle(container: HTMLElement): TomlViewerHandle {
    return {
        dispose() {
            container.innerHTML = '';
            container.classList.remove('toml-viewer-host');
        }
    };
}

// ===========================================================================
// Shell
// ===========================================================================

function buildShell(container: HTMLElement, fileName: string): ShellRefs {
    const wrap = document.createElement('div');
    wrap.className = 'toml-container';

    const header = document.createElement('div');
    header.className = 'toml-header';

    const title = document.createElement('div');
    title.className = 'toml-title';
    title.textContent = fileName;
    title.title = fileName;

    const fileInfo = document.createElement('div');
    fileInfo.className = 'toml-file-info';
    fileInfo.textContent = '';

    header.append(title, fileInfo);

    const toolbar = document.createElement('div');
    toolbar.className = 'toml-toolbar';

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search keys / values…';
    search.className = 'toml-search';
    search.setAttribute('aria-label', 'Search TOML');

    const treeButton = document.createElement('button');
    treeButton.type = 'button';
    treeButton.className = 'toml-button is-active';
    treeButton.textContent = 'Tree';

    const rawButton = document.createElement('button');
    rawButton.type = 'button';
    rawButton.className = 'toml-button';
    rawButton.textContent = 'Raw';
    const flattenButton = document.createElement('button'); flattenButton.type = 'button'; flattenButton.className = 'toml-button'; flattenButton.textContent = 'Flatten';
    const jsonButton = document.createElement('button'); jsonButton.type = 'button'; jsonButton.className = 'toml-button'; jsonButton.textContent = 'JSON';
    const copyJsonButton = document.createElement('button'); copyJsonButton.type = 'button'; copyJsonButton.className = 'toml-button'; copyJsonButton.textContent = 'Copy JSON';

    const expandButton = document.createElement('button');
    expandButton.type = 'button';
    expandButton.className = 'toml-button';
    expandButton.textContent = 'Expand all';

    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'toml-button';
    collapseButton.textContent = 'Collapse all';

    toolbar.append(search, expandButton, collapseButton, treeButton, flattenButton, jsonButton);

    const body = document.createElement('div');
    body.className = 'toml-body';

    const loading = document.createElement('div');
    loading.className = 'toml-loading';
    loading.textContent = 'Loading TOML…';

    const error = document.createElement('div');
    error.className = 'toml-error';
    error.style.display = 'none';

    const treePane = document.createElement('div');
    treePane.className = 'toml-tree';

    const rawPane = document.createElement('pre');
    rawPane.className = 'toml-raw';
    rawPane.style.display = 'block';
    const outputPane = document.createElement('pre'); outputPane.className = 'toml-raw'; outputPane.style.display = 'none';

    const pathBar = document.createElement('div'); pathBar.className = 'toml-path-bar'; pathBar.innerHTML = '<span class="toml-path-label">Path</span><span class="toml-current-path">root</span><button type="button" class="toml-button">Copy Path</button><button type="button" class="toml-button">Copy Flatten Key</button>';
    const workspace = document.createElement('main'); workspace.className = 'toml-workspace';
    const sourcePanel = document.createElement('section'); sourcePanel.className = 'toml-panel'; sourcePanel.innerHTML = '<div class="toml-panel-header"><span>Source</span><span>Cursor sync enabled</span></div>'; sourcePanel.appendChild(rawPane);
    const structurePanel = document.createElement('section'); structurePanel.className = 'toml-panel';
    const structureHeader = document.createElement('div'); structureHeader.className = 'toml-panel-header'; structureHeader.innerHTML = '<span>Tree</span>';
    copyJsonButton.classList.add('toml-copy-json'); structureHeader.appendChild(copyJsonButton);
    body.append(loading, error, treePane, outputPane); structurePanel.append(structureHeader, body); workspace.append(sourcePanel, structurePanel);
    wrap.append(header, pathBar, toolbar, workspace);
    container.appendChild(wrap);

    return {
        root: wrap,
        title,
        fileInfo,
        search,
        treeButton,
        rawButton,
        flattenButton,
        jsonButton,
        copyJsonButton,
        expandButton,
        collapseButton,
        body,
        treePane,
        rawPane,
        outputPane,
        error,
        loading
    };
}

function showLoading(refs: ShellRefs, on: boolean): void {
    refs.loading.style.display = on ? 'block' : 'none';
    refs.treePane.style.display = on ? 'none' : 'block';
}

function showError(refs: ShellRefs, message: string): void {
    refs.error.style.display = 'block';
    refs.error.textContent = message;
}

function updateFileInfo(refs: ShellRefs, file: File, rawText: string): void {
    const lines = countLines(rawText);
    refs.fileInfo.textContent = `${formatBytes(file.size)} • ${lines} lines`;
}

function countLines(text: string): number {
    if (text.length === 0) return 0;
    let count = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) count++;
    }
    return count;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ===========================================================================
// Mode toggle
// ===========================================================================

function setMode(refs: ShellRefs, state: ViewState, mode: ViewMode): void {
    if (state.mode === mode) return;
    state.mode = mode;
    refs.treeButton.classList.toggle('is-active', mode === 'tree');
    refs.rawButton.classList.toggle('is-active', mode === 'raw');
    refs.flattenButton.classList.toggle('is-active', mode === 'flatten');
    refs.jsonButton.classList.toggle('is-active', mode === 'json');
    refs.treePane.style.display = mode === 'tree' ? 'block' : 'none';
    refs.rawPane.style.display = 'block';
    refs.outputPane.style.display = mode === 'flatten' || mode === 'json' ? 'block' : 'none';
}

function flattenValue(value: unknown, path = '$'): Array<[string, unknown]> {
    if (Array.isArray(value)) return value.flatMap((child, index) => flattenValue(child, `${path}[${index}]`));
    if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flattenValue(child, `${path}.${key}`));
    return [[path, value]];
}
function formatFlatValue(value: unknown): string { return typeof value === 'string' ? JSON.stringify(value) : String(value); }

// ===========================================================================
// Tree rendering
// ===========================================================================

function rootId(): string {
    return '$';
}

function childId(parentId: string, key: string, indexHint?: number): string {
    if (indexHint !== undefined) {
        return `${parentId}/${key}#${indexHint}`;
    }
    return `${parentId}/${key}`;
}

function seedExpansion(state: ViewState, ast: TomlAstNode): void {
    state.expanded.set(rootId(), true);
    for (const child of ast.children ?? []) {
        const id = childId(rootId(), child.key);
        // Top-level tables collapsed by default; scalars don't need an entry.
        if (child.children) {
            state.expanded.set(id, false);
        }
    }
}

function setAllExpanded(
    state: ViewState,
    ast: TomlAstNode,
    expanded: boolean
): void {
    state.expanded.clear();
    walkAll(ast, rootId(), (id, node) => {
        if (node.children) {
            state.expanded.set(id, expanded);
        }
    });
}

function walkAll(
    node: TomlAstNode,
    id: string,
    visit: (id: string, node: TomlAstNode) => void
): void {
    visit(id, node);
    if (!node.children) return;
    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const cid = childId(id, child.key, i);
        walkAll(child, cid, visit);
    }
}

interface SearchResult {
    /** Set of node ids that match the query (or are ancestors of a match). */
    visible: Set<string>;
    /** Set of node ids that are direct hits. */
    hits: Set<string>;
}

function applySearch(ast: TomlAstNode, query: string): SearchResult {
    const visible = new Set<string>();
    const hits = new Set<string>();
    if (!query) return { visible, hits };

    const walk = (
        node: TomlAstNode,
        id: string,
        ancestors: string[]
    ): boolean => {
        let selfHit = false;
        const lowerKey = node.key.toLowerCase();
        if (lowerKey.includes(query)) selfHit = true;
        if (
            !selfHit &&
            node.value !== undefined &&
            node.nodeType === 'scalar'
        ) {
            const text = formatScalarForSearch(node);
            if (text.toLowerCase().includes(query)) selfHit = true;
        }
        if (
            !selfHit &&
            (node.nodeType === 'array' ||
                node.nodeType === 'inline-table') &&
            node.value !== undefined
        ) {
            try {
                const text = JSON.stringify(node.value);
                if (text && text.toLowerCase().includes(query)) selfHit = true;
            } catch {
                // ignore non-serializable
            }
        }

        let descendantHit = false;
        if (node.children) {
            for (let i = 0; i < node.children.length; i++) {
                const child = node.children[i];
                const cid = childId(id, child.key, i);
                const childAncestors = [...ancestors, id];
                if (walk(child, cid, childAncestors)) {
                    descendantHit = true;
                }
            }
        }

        if (selfHit || descendantHit) {
            visible.add(id);
            for (const a of ancestors) visible.add(a);
        }
        if (selfHit) hits.add(id);
        return selfHit || descendantHit;
    };

    walk(ast, rootId(), []);
    return { visible, hits };
}

function renderTree(refs: ShellRefs, state: ViewState): void {
    refs.treePane.innerHTML = '';
    if (!state.ast) return;

    const search = applySearch(state.ast, state.query);

    // When a search is active, force-expand every visible ancestor so the
    // hits are always reachable without manual disclosure clicks.
    if (state.query) {
        for (const id of search.visible) {
            state.expanded.set(id, true);
        }
    }

    // The root node has no key — render its children directly.
    const rootChildren = state.ast.children ?? [];
    for (let i = 0; i < rootChildren.length; i++) {
        const child = rootChildren[i];
        const id = childId(rootId(), child.key, i);
        const el = renderNode(child, id, state, search);
        refs.treePane.appendChild(el);
    }
}

function renderNode(
    node: TomlAstNode,
    id: string,
    state: ViewState,
    search: SearchResult
): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'toml-node';
    wrapper.dataset.nodeId = id;

    if (state.query && !search.visible.has(id)) {
        wrapper.classList.add('is-hidden');
    }
    if (search.hits.has(id)) {
        wrapper.classList.add('toml-search-hit');
    }

    const row = document.createElement('div');
    row.className = 'toml-node-row';

    const disclosure = document.createElement('span');
    disclosure.className = 'toml-disclosure';

    const hasChildren = !!node.children && node.children.length > 0;
    const expanded = hasChildren
        ? state.expanded.get(id) ?? false
        : false;
    if (hasChildren) {
        disclosure.textContent = expanded ? '▾' : '▸';
        row.classList.add('is-clickable');
    } else {
        disclosure.classList.add('is-empty');
        disclosure.textContent = '·';
    }

    row.appendChild(disclosure);

    const keyEl = document.createElement('span');
    keyEl.className = 'toml-key';
    if (node.nodeType === 'array-of-tables') {
        keyEl.classList.add('toml-key-aot');
        keyEl.textContent = `[[${node.key}]]`;
    } else if (node.nodeType === 'table') {
        keyEl.classList.add('toml-key-table');
        keyEl.textContent = node.key;
    } else {
        keyEl.textContent = node.key;
    }
    row.appendChild(keyEl);

    if (
        node.nodeType === 'scalar' ||
        node.nodeType === 'array' ||
        node.nodeType === 'inline-table'
    ) {
        const eq = document.createElement('span');
        eq.className = 'toml-equals';
        eq.textContent = '=';
        row.appendChild(eq);

        const valEl = document.createElement('span');
        valEl.className = 'toml-value';
        if (node.valueType) {
            valEl.classList.add(`toml-value-${node.valueType}`);
        }
        valEl.textContent = formatValue(node);
        row.appendChild(valEl);
    }

    if (hasChildren) {
        row.addEventListener('click', () => {
            const cur = state.expanded.get(id) ?? false;
            state.expanded.set(id, !cur);
            renderTree(getShellRefsFromTree(wrapper), state);
        });
    }

    wrapper.appendChild(row);

    if (hasChildren && expanded) {
        const childContainer = document.createElement('div');
        childContainer.className = 'toml-children';
        for (let i = 0; i < (node.children ?? []).length; i++) {
            const child = node.children![i];
            const cid = childId(id, child.key, i);
            childContainer.appendChild(renderNode(child, cid, state, search));
        }
        wrapper.appendChild(childContainer);
    }

    return wrapper;
}

/**
 * Climb back to the tree pane to trigger a re-render. Cheap because the tree
 * pane is the closest ancestor with the `toml-tree` class — we never escape
 * the viewer host.
 */
function getShellRefsFromTree(el: HTMLElement): ShellRefs {
    const treePane = el.closest('.toml-tree') as HTMLElement;
    const root = el.closest('.toml-container') as HTMLElement;
    return {
        root,
        title: root.querySelector('.toml-title') as HTMLElement,
        fileInfo: root.querySelector('.toml-file-info') as HTMLElement,
        search: root.querySelector('.toml-search') as HTMLInputElement,
        treeButton: root.querySelector('.toml-button') as HTMLButtonElement,
        rawButton: root.querySelectorAll('.toml-button')[1] as HTMLButtonElement,
        expandButton: root.querySelectorAll('.toml-button')[2] as HTMLButtonElement,
        collapseButton: root.querySelectorAll('.toml-button')[3] as HTMLButtonElement,
        body: root.querySelector('.toml-body') as HTMLElement,
        treePane,
        rawPane: root.querySelector('.toml-raw') as HTMLPreElement,
        error: root.querySelector('.toml-error') as HTMLElement,
        loading: root.querySelector('.toml-loading') as HTMLElement
    };
}

// ===========================================================================
// Value formatting
// ===========================================================================

function formatValue(node: TomlAstNode): string {
    switch (node.nodeType) {
        case 'scalar':
            return formatScalar(node.value, node.valueType);
        case 'array':
            return formatArrayPreview(node.value as unknown[]);
        case 'inline-table':
            return formatInlineTablePreview(
                node.value as Record<string, unknown>
            );
        default:
            return '';
    }
}

function formatScalar(
    value: unknown,
    valueType?: TomlValueType
): string {
    if (typeof value === 'string') {
        if (
            valueType === 'datetime-offset' ||
            valueType === 'datetime-local' ||
            valueType === 'date-local' ||
            valueType === 'time-local'
        ) {
            return value;
        }
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (Number.isNaN(value)) return 'nan';
        if (value === Infinity) return 'inf';
        if (value === -Infinity) return '-inf';
        return String(value);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
}

function formatScalarForSearch(node: TomlAstNode): string {
    return formatScalar(node.value, node.valueType);
}

function formatArrayPreview(arr: unknown[]): string {
    if (arr.length === 0) return '[]';
    const parts: string[] = [];
    let used = 0;
    for (const item of arr) {
        const s = formatArrayItem(item);
        used += s.length;
        if (used > 80) {
            parts.push('…');
            break;
        }
        parts.push(s);
    }
    return `[${parts.join(', ')}]`;
}

function formatArrayItem(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (Number.isNaN(value)) return 'nan';
        if (value === Infinity) return 'inf';
        if (value === -Infinity) return '-inf';
        return String(value);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) return formatArrayPreview(value);
    if (value !== null && typeof value === 'object') {
        return formatInlineTablePreview(value as Record<string, unknown>);
    }
    return String(value);
}

function formatInlineTablePreview(obj: Record<string, unknown>): string {
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    const parts: string[] = [];
    let used = 0;
    for (const k of keys) {
        const s = `${k} = ${formatArrayItem(obj[k])}`;
        used += s.length;
        if (used > 80) {
            parts.push('…');
            break;
        }
        parts.push(s);
    }
    return `{ ${parts.join(', ')} }`;
}
