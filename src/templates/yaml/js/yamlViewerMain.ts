// Orchestration layer for the YAML viewer (issue #64).
//
// Mirrors `templates/json/js/jsonViewerMain.ts` because the two viewers
// share the lazy-render tree pattern + search reducer. The YAML-specific
// pieces are:
//
//   1. Vendor `js-yaml` is loaded by injecting a `<script>` tag pointing
//      at `chrome.runtime.getURL('vendor/js-yaml.min.js')`. The module
//      exposes `window.jsyaml`. We cache the load promise so subsequent
//      mounts reuse it.
//   2. `parseYamlSource` (from `yamlNodeBuilder`) captures anchor /
//      alias bindings via the `listener` hook and `buildYamlTree`
//      converts the parsed value(s) into a tree where alias references
//      are leaf nodes carrying `*name` so we never re-render shared
//      subtrees.
//   3. A "Tree / Source" toggle replaces the JSON viewer's single tree
//      surface — the source view dumps the raw YAML text for users who
//      want to inspect comments / formatting that a JSON-shaped tree
//      cannot represent.
//
// Search wiring + keyboard shortcuts are identical to the JSON viewer.

import {
    YamlTreeNode,
    YamlValueKind,
    YamlParseResult,
    JsYamlLike,
    parseYamlSource,
    buildYamlTree,
    expand,
    collapse,
    toggle,
    expandAncestorsOf,
    isContainer,
    search,
    nextMatchIndex,
    prevMatchIndex,
    walk
} from '../../../utils/yamlNodeBuilder';
import { YAML_VIEWER_CSS } from './yamlViewerStyles';
import { tokenizeYamlSource } from '../../../utils/configSourceTokenizer';

const STYLE_ELEMENT_ID = 'omni-viewer-yaml-styles';
const VENDOR_PATH = 'vendor/js-yaml.min.js';

export interface YamlViewerHandle {
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
    flattenButton: HTMLButtonElement;
    jsonButton: HTMLButtonElement;
    copyJsonButton: HTMLButtonElement;
    treeHost: HTMLElement;
    sourceHost: HTMLPreElement;
    outputHost: HTMLPreElement;
}

interface ViewerState {
    tree: YamlTreeNode | null;
    rowElements: WeakMap<YamlTreeNode, HTMLElement>;
    childContainers: WeakMap<YamlTreeNode, HTMLElement>;
    matches: YamlTreeNode[];
    currentMatchIndex: number;
    mode: 'tree' | 'source' | 'flatten' | 'json';
}

declare global {
    interface Window {
        jsyaml?: JsYamlLike;
        __omniMountYaml?: typeof mountYamlViewer;
    }
}

let pendingJsYamlLoad: Promise<JsYamlLike> | null = null;

function resolveVendorUrl(relativePath: string): string {
    if (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.getURL === 'function'
    ) {
        try {
            return chrome.runtime.getURL(relativePath);
        } catch {
            /* fall through */
        }
    }
    return relativePath;
}

/**
 * Lazy-load the vendored js-yaml bundle. Returns a cached promise so
 * repeat mounts share the same `<script>` tag.
 */
function loadJsYaml(): Promise<JsYamlLike> {
    if (typeof window === 'undefined') {
        return Promise.reject(new Error('yaml viewer: window is undefined'));
    }
    if (window.jsyaml) return Promise.resolve(window.jsyaml);
    if (pendingJsYamlLoad) return pendingJsYamlLoad;

    pendingJsYamlLoad = new Promise((resolve, reject) => {
        const url = resolveVendorUrl(VENDOR_PATH);
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => {
            if (window.jsyaml) {
                resolve(window.jsyaml);
            } else {
                reject(new Error('yaml viewer: js-yaml did not expose window.jsyaml'));
            }
        };
        script.onerror = () => {
            pendingJsYamlLoad = null;
            reject(new Error(`yaml viewer: failed to load ${url}`));
        };
        document.head.appendChild(script);
    });
    return pendingJsYamlLoad;
}

function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = YAML_VIEWER_CSS;
    document.head.appendChild(style);
}

/**
 * Mount the YAML viewer into `container`. Returns a handle whose
 * `dispose()` clears the container and removes any listeners attached.
 */
export async function mountYamlViewer(
    file: File,
    container: HTMLElement
): Promise<YamlViewerHandle> {
    ensureStylesInjected();
    container.innerHTML = '';
    container.classList.add('yv-host');

    const dom = buildShell(container, file.name);
    const state: ViewerState = {
        tree: null,
        rowElements: new WeakMap(),
        childContainers: new WeakMap(),
        matches: [],
        currentMatchIndex: -1,
        mode: 'tree'
    };

    let text = '';
    try {
        text = await file.text();
    } catch (readErr) {
        const message = readErr instanceof Error ? readErr.message : String(readErr);
        renderError(dom.treeHost, `Failed to read file: ${message}`);
        return makeHandle(container, dom, () => {});
    }

    renderHighlightedSource(dom.sourceHost, text);

    let jsyaml: JsYamlLike;
    try {
        jsyaml = await loadJsYaml();
    } catch (loadErr) {
        const message = loadErr instanceof Error ? loadErr.message : String(loadErr);
        renderError(dom.treeHost, `Failed to load YAML parser: ${message}`);
        return makeHandle(container, dom, () => {});
    }

    const parsed: YamlParseResult = parseYamlSource(text, jsyaml);
    if (parsed.error) {
        renderError(dom.treeHost, `Failed to parse YAML: ${parsed.error.message}`);
        return makeHandle(container, dom, () => {});
    }

    state.tree = buildYamlTree(parsed);
    renderTree(state, dom);
    const parsedValue = parsed.documents.length === 1 ? parsed.documents[0] : parsed.documents;

    const cleanups: Array<() => void> = [];

    const onInput = () => runSearch(state, dom, dom.searchInput.value);
    dom.searchInput.addEventListener('input', onInput);
    cleanups.push(() => dom.searchInput.removeEventListener('input', onInput));

    const onKey = (event: KeyboardEvent) => handleSearchKey(event, state, dom);
    dom.searchInput.addEventListener('keydown', onKey);
    cleanups.push(() => dom.searchInput.removeEventListener('keydown', onKey));

    const onContainerKey = (event: KeyboardEvent) => handleContainerKey(event, state, dom);
    container.addEventListener('keydown', onContainerKey);
    cleanups.push(() => container.removeEventListener('keydown', onContainerKey));
    if (!container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '0');
    }

    const onPrev = () => stepMatch(state, dom, -1);
    const onNext = () => stepMatch(state, dom, 1);
    dom.prevButton.addEventListener('click', onPrev);
    dom.nextButton.addEventListener('click', onNext);
    cleanups.push(() => {
        dom.prevButton.removeEventListener('click', onPrev);
        dom.nextButton.removeEventListener('click', onNext);
    });

    const onTreeMode = () => setMode(state, dom, 'tree');
    const onSourceMode = () => setMode(state, dom, 'source');
    const onFlattenMode = () => {
        dom.outputHost.textContent = flattenValue(parsedValue).map(([path, value]) => `${path} = ${formatFlatValue(value)}`).join('\n');
        setMode(state, dom, 'flatten');
    };
    const onJsonMode = () => { dom.outputHost.textContent = JSON.stringify(parsedValue, null, 2); setMode(state, dom, 'json'); };
    const onCopyJson = () => { void navigator.clipboard?.writeText(JSON.stringify(parsedValue, null, 2)); };
    dom.treeButton.addEventListener('click', onTreeMode);
    dom.sourceButton.addEventListener('click', onSourceMode);
    dom.flattenButton.addEventListener('click', onFlattenMode);
    dom.jsonButton.addEventListener('click', onJsonMode);
    dom.copyJsonButton.addEventListener('click', onCopyJson);
    cleanups.push(() => {
        dom.treeButton.removeEventListener('click', onTreeMode);
        dom.sourceButton.removeEventListener('click', onSourceMode);
        dom.flattenButton.removeEventListener('click', onFlattenMode);
        dom.jsonButton.removeEventListener('click', onJsonMode);
        dom.copyJsonButton.removeEventListener('click', onCopyJson);
    });

    updateMatchInfo(state, dom);
    setMode(state, dom, 'tree');

    return makeHandle(container, dom, () => {
        for (const c of cleanups) c();
    });
}

function renderHighlightedSource(host: HTMLElement, source: string): void {
    const fragment = document.createDocumentFragment();
    for (const token of tokenizeYamlSource(source)) {
        if (!token.kind) {
            fragment.appendChild(document.createTextNode(token.text));
            continue;
        }
        const span = document.createElement('span');
        span.className = `yv-source-token-${token.kind}`;
        span.textContent = token.text;
        fragment.appendChild(span);
    }
    host.replaceChildren(fragment);
}

function makeHandle(
    container: HTMLElement,
    _dom: ViewerDom,
    cleanup: () => void
): YamlViewerHandle {
    return {
        dispose() {
            cleanup();
            container.innerHTML = '';
            container.classList.remove('yv-host');
        }
    };
}

// ---------------------------------------------------------------------------
// Shell DOM.
// ---------------------------------------------------------------------------

function buildShell(container: HTMLElement, fileName: string): ViewerDom {
    const root = document.createElement('div');
    root.className = 'yv-container';

    const header = document.createElement('header'); header.className = 'yv-header';
    const heading = document.createElement('div');
    const title = document.createElement('div'); title.className = 'yv-title'; title.textContent = fileName;
    const subtitle = document.createElement('div'); subtitle.className = 'yv-subtitle'; subtitle.textContent = 'Ready';
    const badge = document.createElement('div'); badge.className = 'yv-badge'; badge.textContent = 'YAML';
    heading.append(title, subtitle); header.append(heading, badge);
    const toolbar = document.createElement('div');
    toolbar.className = 'yv-toolbar';

    const modeGroup = document.createElement('div');
    modeGroup.className = 'yv-mode-group';
    const treeButton = document.createElement('button');
    treeButton.type = 'button';
    treeButton.className = 'yv-mode-button is-active';
    treeButton.textContent = 'Tree';
    treeButton.title = 'Tree view';
    const sourceButton = document.createElement('button');
    sourceButton.type = 'button';
    sourceButton.className = 'yv-mode-button';
    sourceButton.textContent = 'Source';
    sourceButton.title = 'Raw YAML source';
    const flattenButton = document.createElement('button'); flattenButton.type = 'button'; flattenButton.className = 'yv-mode-button'; flattenButton.textContent = 'Flatten';
    const jsonButton = document.createElement('button'); jsonButton.type = 'button'; jsonButton.className = 'yv-mode-button'; jsonButton.textContent = 'JSON';
    modeGroup.append(treeButton, flattenButton, jsonButton);

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'yv-search';
    searchInput.placeholder =
        'Search keys / values  (Ctrl+F to focus, Enter / Shift+Enter to step)';
    searchInput.setAttribute('aria-label', 'Search YAML keys and values');

    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'yv-button';
    prevButton.textContent = 'Prev';
    prevButton.title = 'Previous match (Shift+Enter / N)';

    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'yv-button';
    nextButton.textContent = 'Next';
    nextButton.title = 'Next match (Enter / N)';

    const matchInfo = document.createElement('span');
    matchInfo.className = 'yv-match-info';
    matchInfo.textContent = '';

    const copyJsonButton = document.createElement('button'); copyJsonButton.type = 'button'; copyJsonButton.className = 'yv-button'; copyJsonButton.textContent = 'Copy JSON';
    toolbar.append(modeGroup, searchInput);

    const treeHost = document.createElement('div');
    treeHost.className = 'yv-content';

    const sourceHost = document.createElement('pre');
    sourceHost.className = 'yv-source';
    const outputHost = document.createElement('pre'); outputHost.className = 'yv-source'; outputHost.style.display = 'none';

    const workspace = document.createElement('main'); workspace.className = 'yv-workspace';
    const sourcePanel = document.createElement('section'); sourcePanel.className = 'yv-panel'; sourcePanel.innerHTML = '<div class="yv-panel-header"><span>Source</span><span>Line 1, Column 1</span></div>'; sourcePanel.appendChild(sourceHost);
    const structurePanel = document.createElement('section'); structurePanel.className = 'yv-panel';
    const structureHeader = document.createElement('div'); structureHeader.className = 'yv-panel-header';
    const structureTitle = document.createElement('span'); structureTitle.textContent = 'Structure tree';
    const panelActions = document.createElement('div'); panelActions.className = 'yv-panel-actions'; panelActions.append(matchInfo, prevButton, nextButton, copyJsonButton);
    structureHeader.append(structureTitle, panelActions); structurePanel.append(structureHeader, treeHost, outputHost);
    workspace.append(sourcePanel, structurePanel); root.append(header, toolbar, workspace);
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
        flattenButton,
        jsonButton,
        copyJsonButton,
        treeHost,
        sourceHost,
        outputHost
    };
}

function renderError(treeHost: HTMLElement, message: string): void {
    treeHost.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'yv-error';
    err.setAttribute('role', 'alert');
    err.textContent = message;
    treeHost.appendChild(err);
}

function setMode(state: ViewerState, dom: ViewerDom, mode: 'tree' | 'source' | 'flatten' | 'json'): void {
    state.mode = mode;
    dom.treeHost.style.display = mode === 'tree' ? '' : 'none';
    dom.sourceHost.style.display = '';
    dom.outputHost.style.display = mode === 'flatten' || mode === 'json' ? '' : 'none';
    dom.treeButton.classList.toggle('is-active', mode === 'tree');
    dom.sourceButton.classList.toggle('is-active', mode === 'source');
    dom.flattenButton.classList.toggle('is-active', mode === 'flatten');
    dom.jsonButton.classList.toggle('is-active', mode === 'json');
}

function flattenValue(value: unknown, path = '$'): Array<[string, unknown]> {
    if (Array.isArray(value)) return value.flatMap((child, index) => flattenValue(child, `${path}[${index}]`));
    if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flattenValue(child, `${path}.${key}`));
    return [[path, value]];
}
function formatFlatValue(value: unknown): string { return typeof value === 'string' ? JSON.stringify(value) : String(value); }

// ---------------------------------------------------------------------------
// Tree rendering (lazy).
// ---------------------------------------------------------------------------

function renderTree(state: ViewerState, dom: ViewerDom): void {
    dom.treeHost.innerHTML = '';
    if (!state.tree) return;
    const rootEl = renderNode(state, state.tree);
    dom.treeHost.appendChild(rootEl);
}

function renderNode(state: ViewerState, node: YamlTreeNode): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'yv-node';

    const row = document.createElement('div');
    row.className = 'yv-row';
    if (isContainer(node)) {
        row.classList.add('yv-toggleable');
    }
    state.rowElements.set(node, row);

    const toggleEl = document.createElement('span');
    toggleEl.className = 'yv-toggle';
    if (!isContainer(node)) {
        toggleEl.classList.add('yv-leaf');
    }
    updateToggleGlyph(toggleEl, node);
    row.appendChild(toggleEl);

    const keyEl = document.createElement('span');
    keyEl.className = 'yv-key';
    if (node.parent && node.parent.kind === 'array') {
        keyEl.classList.add('yv-array-index');
    }
    keyEl.textContent = node.key;
    row.appendChild(keyEl);

    const colon = document.createElement('span');
    colon.className = 'yv-colon';
    colon.textContent = ':';
    row.appendChild(colon);

    if (isContainer(node)) {
        const summary = document.createElement('span');
        summary.className = 'yv-summary';
        summary.textContent = containerSummary(node);
        row.appendChild(summary);
    } else {
        const value = document.createElement('span');
        value.className = `yv-value yv-value-${node.kind}`;
        value.textContent = node.primitive ?? '';
        row.appendChild(value);
    }

    // Anchor / alias chips. The anchor chip lives on the source node;
    // the alias chip lives on the alias leaf and points at the anchor
    // name. Both are styled as small pill labels via the runtime CSS.
    if (node.anchor) {
        const chip = document.createElement('span');
        chip.className = 'yv-anchor-chip';
        chip.textContent = `&${node.anchor}`;
        chip.title = `Anchor: ${node.anchor}`;
        row.appendChild(chip);
    }
    if (node.alias) {
        const chip = document.createElement('span');
        chip.className = 'yv-alias-chip';
        chip.textContent = `→ &${node.alias}`;
        chip.title = `Alias of anchor "${node.alias}"`;
        row.appendChild(chip);
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
        childContainer.className = 'yv-children';
        childContainer.style.display = node.expanded ? '' : 'none';
        state.childContainers.set(node, childContainer);
        if (node.expanded) {
            materializeChildrenIfNeeded(state, node, childContainer);
        }
        wrap.appendChild(childContainer);
    }

    return wrap;
}

function materializeChildrenIfNeeded(
    state: ViewerState,
    node: YamlTreeNode,
    container: HTMLElement
): void {
    if (!node.children) return;
    if (container.dataset.yvMaterialized === '1') return;
    container.dataset.yvMaterialized = '1';
    const frag = document.createDocumentFragment();
    for (const child of node.children) {
        frag.appendChild(renderNode(state, child));
    }
    container.appendChild(frag);
}

function updateToggleGlyph(el: HTMLElement, node: YamlTreeNode): void {
    if (!isContainer(node)) {
        el.textContent = '';
        return;
    }
    el.textContent = node.expanded ? '▼' : '▶';
}

function containerSummary(node: YamlTreeNode): string {
    const count = node.children?.length ?? 0;
    if (node.kind === 'array') return `Array(${count})`;
    return `Object{${count}}`;
}

function applyMatchClass(row: HTMLElement, node: YamlTreeNode): void {
    if (node.matched) {
        row.classList.add('yv-match-highlight');
    } else {
        row.classList.remove('yv-match-highlight');
    }
}

// ---------------------------------------------------------------------------
// Search wiring.
// ---------------------------------------------------------------------------

function runSearch(state: ViewerState, dom: ViewerDom, query: string): void {
    if (!state.tree) return;

    const prevCurrent = state.matches[state.currentMatchIndex];
    if (prevCurrent) {
        const prevRow = state.rowElements.get(prevCurrent);
        prevRow?.classList.remove('yv-current');
    }

    const prevMatches = state.matches;
    const result = search(state.tree, query);
    state.matches = result.matches;

    for (const oldMatch of prevMatches) {
        const row = state.rowElements.get(oldMatch);
        if (row) applyMatchClass(row, oldMatch);
    }

    if (result.matches.length > 0) {
        const changed = expandAncestorsOf(result.matches);
        for (const ancestor of changed) {
            syncExpandedDom(state, ancestor);
        }
    }

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

function syncExpandedDom(state: ViewerState, node: YamlTreeNode): void {
    const row = state.rowElements.get(node);
    if (row) {
        const toggleEl = row.querySelector<HTMLElement>('.yv-toggle');
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
    dom.treeHost.querySelectorAll('.yv-current').forEach((el) => {
        el.classList.remove('yv-current');
    });
    row.classList.add('yv-current');
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
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        dom.searchInput.focus();
        dom.searchInput.select();
        return;
    }

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

// Re-export pure helpers for tests + composition (mirrors the JSON viewer).
export {
    buildYamlTree,
    parseYamlSource,
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
export type { YamlTreeNode, YamlValueKind };
