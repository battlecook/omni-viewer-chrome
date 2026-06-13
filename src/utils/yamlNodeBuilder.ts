// YAML node-builder for the Chrome viewer (issue #64).
//
// The vendored copy of `js-yaml` (v4.1.0) under `vendor/js-yaml.min.js`
// resolves anchors / aliases up front and returns a plain JS value, so the
// shape we get back from `jsyaml.load` looks just like a JSON tree. That
// makes the JSON viewer's `TreeNode` model (issue #62) a natural fit, but
// we lose anchor / alias provenance unless we instrument the parse.
//
// To preserve the structural information called out in the issue's DoD we:
//
//   1. Run the parse with `jsyaml.load(text, { listener })`. The listener
//      fires on every `open` / `close` for every state, and `state.anchor`
//      is the anchor *name* the parser bound on its way in. For anchors
//      we capture `(anchor, state.result)` so we can tell which JS value
//      a `&name` refers to.
//   2. Walk the resulting JS value once. The first time we see a
//      container reference, that node is the *anchor source*; every
//      subsequent occurrence is an *alias* — js-yaml repeats the same
//      object reference. We mark the alias node with the anchor name and
//      stop expanding to avoid infinite recursion.
//   3. The output is a `YamlTreeNode` graph that mirrors the JSON
//      viewer's `TreeNode` shape (key / kind / children / expanded /
//      matched / parent) plus YAML-specific fields (`anchor`, `alias`,
//      `documentIndex`).
//
// This module is intentionally DOM-free. The orchestrator
// (`yamlViewerMain.ts`) consumes the tree and renders it lazily, the
// same way `jsonViewerMain.ts` does for JSON.

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Discriminator for the YAML scalar / container kind. Mirrors the JSON
 * viewer's `JsonValueKind` so the orchestrator can re-use the same
 * rendering pattern, with the addition of `'alias'` for `*name` references.
 */
export type YamlValueKind =
    | 'object'
    | 'array'
    | 'string'
    | 'number'
    | 'boolean'
    | 'null'
    | 'alias';

/**
 * Tree node for the YAML viewer. Same skeleton as the JSON tree's
 * `TreeNode` — search / expand / match flags live on the node so the
 * orchestrator can mutate state without re-traversing the data.
 *
 *   - `anchor`: present when this node is the *source* of one or more
 *     aliases. Holds the anchor name (no leading `&`).
 *   - `alias`: present when this node is an *alias reference* (`*name`).
 *     Holds the referenced anchor name (no leading `*`). The node is a
 *     leaf in the tree even when the original anchor was a container; we
 *     intentionally do NOT recursively duplicate the subtree to keep the
 *     view finite + cycle-safe.
 *   - `documentIndex`: which YAML document this node belongs to (always
 *     `0` for single-document files).
 */
export interface YamlTreeNode {
    /** Display key for this node (root uses `'$'`, multi-doc roots use `'document N'`). */
    key: string;
    /** Path from the root, in order. The root's path is `[]`. */
    path: ReadonlyArray<string | number>;
    /** Discriminated kind of the underlying YAML value. */
    kind: YamlValueKind;
    /**
     * For primitive (and alias) kinds, the rendered value as a string.
     * Strings are quoted to match the JSON viewer's convention; aliases
     * render as `*name`. Undefined for containers.
     */
    primitive?: string;
    /** Children for containers; undefined for primitives + aliases. */
    children?: YamlTreeNode[];
    /** True iff this node should render its children. Default: root only. */
    expanded: boolean;
    /** True iff this node matched the most recent search query. */
    matched: boolean;
    /** Back-reference for fast ancestor walks. Root's parent is `null`. */
    parent: YamlTreeNode | null;
    /** Anchor name when this container / scalar is bound to `&anchor`. */
    anchor?: string;
    /** Anchor name when this node is an alias (`*anchor`). */
    alias?: string;
    /** Which document the node belongs to (0-indexed). */
    documentIndex: number;
}

export interface BuildYamlTreeOptions {
    /** Optional override for the root node's display key. */
    rootKey?: string;
    /** Whether the root is initially expanded. Defaults to `true`. */
    expandRoot?: boolean;
}

/**
 * Subset of the js-yaml runtime surface we rely on. The vendored bundle
 * is loaded via a `<script>` tag and exposed as `window.jsyaml`; we
 * never `import` it so this module stays test-friendly under Jest
 * (callers may pass a stub via `parseYamlSource`).
 */
export interface JsYamlLike {
    load(text: string, opts?: any): unknown;
    loadAll(text: string, iterator?: (doc: unknown) => void, opts?: any): unknown[] | void;
    YAMLException?: new (...args: any[]) => Error;
}

/** Result of `parseYamlSource` — a list of documents + diagnostics. */
export interface YamlParseResult {
    documents: unknown[];
    /** Whether the source contained an explicit `---` document separator. */
    multiDocument: boolean;
    /** Anchor name → first JS value bound to that anchor. */
    anchors: Map<string, unknown>;
    /** Parse error, if any. The result is still usable when `error === null`. */
    error: { message: string } | null;
}

/**
 * Parse a YAML source string into one-or-more JS values, using the
 * supplied `js-yaml` instance (typically `window.jsyaml`). Captures
 * anchor bindings via the parser's `listener` hook so the tree-builder
 * can preserve `&name` provenance even though js-yaml resolves aliases
 * eagerly.
 */
export function parseYamlSource(text: string, jsyaml: JsYamlLike): YamlParseResult {
    const anchors = new Map<string, unknown>();
    const listener = (event: 'open' | 'close', state: any) => {
        if (event !== 'close') return;
        const name = state && typeof state.anchor === 'string' ? state.anchor : null;
        if (!name) return;
        if (!anchors.has(name)) {
            anchors.set(name, state.result);
        }
    };

    const multiDocument = /^---\s*$/m.test(text) || /^---\s/m.test(text);

    const documents: unknown[] = [];
    let error: { message: string } | null = null;
    try {
        if (multiDocument) {
            jsyaml.loadAll(text, (doc) => {
                documents.push(doc);
            }, { listener });
        } else {
            const single = jsyaml.load(text, { listener });
            documents.push(single);
        }
    } catch (e) {
        error = { message: e instanceof Error ? e.message : String(e) };
    }

    return { documents, multiDocument, anchors, error };
}

/**
 * Build a forest of `YamlTreeNode`s from a parsed YAML result. For
 * single-document inputs the returned root represents the document's
 * top-level value; for multi-document inputs the root is a synthetic
 * "documents" container whose children are the per-document roots.
 *
 * `anchors` and `aliases` are populated by walking the JS values with
 * an identity-tracking visitor: the first time we see a container the
 * tree node carries `anchor` (when the parser bound a name to it); any
 * subsequent occurrence becomes a leaf node with `alias` set. This
 * mirrors how YAML 1.2 actually represents aliases — the data graph
 * shares structure rather than duplicating it.
 */
export function buildYamlTree(
    parsed: YamlParseResult,
    options: BuildYamlTreeOptions = {}
): YamlTreeNode {
    const expandRoot = options.expandRoot ?? true;
    const rootKey = options.rootKey ?? '$';

    // Reverse anchor lookup: object reference → name. Multiple anchors
    // pointing at the same value (rare but legal) are collapsed onto the
    // first name we encounter; the tree only displays one at a time.
    const refToAnchor = new Map<unknown, string>();
    for (const [name, value] of parsed.anchors) {
        if (value !== null && (typeof value === 'object' || typeof value === 'string')) {
            if (!refToAnchor.has(value)) {
                refToAnchor.set(value, name);
            }
        }
    }

    // Identity tracker: WeakSet would be ideal but `unknown` may be a
    // primitive (string anchors), so we use a plain Set guarded by a
    // typeof check before insertion.
    const seen = new Set<object>();

    if (parsed.documents.length <= 1) {
        const value = parsed.documents.length === 1 ? parsed.documents[0] : null;
        return buildNode(value, {
            key: rootKey,
            path: [],
            parent: null,
            expanded: expandRoot,
            documentIndex: 0,
            refToAnchor,
            seen
        });
    }

    // Multi-document: synthesize a wrapper "documents" array.
    const root: YamlTreeNode = {
        key: rootKey,
        path: [],
        kind: 'array',
        expanded: expandRoot,
        matched: false,
        parent: null,
        documentIndex: 0,
        children: []
    };
    const children: YamlTreeNode[] = [];
    parsed.documents.forEach((doc, index) => {
        const docNode = buildNode(doc, {
            key: `document ${index}`,
            path: [index],
            parent: root,
            expanded: false,
            documentIndex: index,
            refToAnchor,
            seen
        });
        children.push(docNode);
    });
    root.children = children;
    return root;
}

interface BuildContext {
    key: string;
    path: ReadonlyArray<string | number>;
    parent: YamlTreeNode | null;
    expanded: boolean;
    documentIndex: number;
    refToAnchor: Map<unknown, string>;
    seen: Set<object>;
}

function buildNode(value: unknown, ctx: BuildContext): YamlTreeNode {
    const kind = detectKind(value);
    const node: YamlTreeNode = {
        key: ctx.key,
        path: ctx.path,
        kind,
        expanded: ctx.expanded,
        matched: false,
        parent: ctx.parent,
        documentIndex: ctx.documentIndex
    };

    // Alias detection: a container we've already materialized somewhere
    // in this tree must be an alias reference (js-yaml shares the same
    // object identity for anchored containers). We turn it into a leaf.
    if ((kind === 'object' || kind === 'array') && value !== null && typeof value === 'object') {
        const obj = value as object;
        const anchorName = ctx.refToAnchor.get(obj);
        if (ctx.seen.has(obj)) {
            // Aliased reuse — render as a leaf. `alias` is the anchor
            // name when known; we still surface a `*?` placeholder when
            // the parser didn't capture a name (e.g. a synthetic merge).
            node.kind = 'alias';
            node.alias = anchorName ?? '?';
            node.primitive = `*${node.alias}`;
            node.children = undefined;
            return node;
        }
        ctx.seen.add(obj);
        if (anchorName) {
            node.anchor = anchorName;
        }
    } else if (kind === 'string' && typeof value === 'string') {
        // Anchors can also bind to scalars; same string can be reused
        // by alias. We don't dedupe by string identity (two equal
        // strings might be unrelated), so only mark the anchor source.
        const anchorName = ctx.refToAnchor.get(value);
        if (anchorName) {
            node.anchor = anchorName;
        }
    }

    if (kind === 'object') {
        const obj = value as Record<string, unknown>;
        const children: YamlTreeNode[] = [];
        for (const childKey of Object.keys(obj)) {
            children.push(buildNode(obj[childKey], {
                key: childKey,
                path: [...ctx.path, childKey],
                parent: node,
                expanded: false,
                documentIndex: ctx.documentIndex,
                refToAnchor: ctx.refToAnchor,
                seen: ctx.seen
            }));
        }
        node.children = children;
    } else if (kind === 'array') {
        const arr = value as unknown[];
        const children: YamlTreeNode[] = [];
        for (let i = 0; i < arr.length; i++) {
            children.push(buildNode(arr[i], {
                key: String(i),
                path: [...ctx.path, i],
                parent: node,
                expanded: false,
                documentIndex: ctx.documentIndex,
                refToAnchor: ctx.refToAnchor,
                seen: ctx.seen
            }));
        }
        node.children = children;
    } else {
        node.primitive = stringifyPrimitive(value, kind);
    }

    return node;
}

function detectKind(value: unknown): YamlValueKind {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Date) return 'string';
    const t = typeof value;
    if (t === 'object') return 'object';
    if (t === 'string') return 'string';
    if (t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    return 'null';
}

function stringifyPrimitive(value: unknown, kind: YamlValueKind): string {
    if (kind === 'null') return 'null';
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (kind === 'string') return JSON.stringify(value);
    return String(value);
}

// ---------------------------------------------------------------------------
// Pure mutators — same shape as jsonTree.ts so the orchestrator can re-use
// the search/expand pattern verbatim.
// ---------------------------------------------------------------------------

/** Mark `node` as expanded. No-op for primitives + aliases. Returns `node`. */
export function expand(node: YamlTreeNode): YamlTreeNode {
    if (isContainer(node)) {
        node.expanded = true;
    }
    return node;
}

/** Mark `node` as collapsed. No-op for primitives + aliases. Returns `node`. */
export function collapse(node: YamlTreeNode): YamlTreeNode {
    if (isContainer(node)) {
        node.expanded = false;
    }
    return node;
}

/** Toggle expanded state. No-op for primitives + aliases. Returns the new state. */
export function toggle(node: YamlTreeNode): boolean {
    if (!isContainer(node)) return node.expanded;
    node.expanded = !node.expanded;
    return node.expanded;
}

export function isContainer(node: YamlTreeNode): boolean {
    return node.kind === 'object' || node.kind === 'array';
}

/**
 * Walk parents of every node in `matches` and set `expanded = true` on
 * each ancestor. Returns the Set of nodes whose `expanded` flag actually
 * changed (so the DOM layer can materialize their children for the
 * first time).
 */
export function expandAncestorsOf(
    matches: ReadonlyArray<YamlTreeNode>
): Set<YamlTreeNode> {
    const changed = new Set<YamlTreeNode>();
    for (const match of matches) {
        let cursor: YamlTreeNode | null = match.parent;
        while (cursor) {
            if (isContainer(cursor) && !cursor.expanded) {
                cursor.expanded = true;
                changed.add(cursor);
            }
            cursor = cursor.parent;
        }
    }
    return changed;
}

/** Clear `matched` flags across the whole tree (used between searches). */
export function clearMatches(root: YamlTreeNode): void {
    walk(root, (n) => {
        n.matched = false;
    });
}

/** Depth-first traversal helper. */
export function walk(node: YamlTreeNode, visit: (n: YamlTreeNode) => void): void {
    visit(node);
    if (node.children) {
        for (const child of node.children) {
            walk(child, visit);
        }
    }
}

// ---------------------------------------------------------------------------
// Search reducer — same contract as the JSON viewer's `search`.
// ---------------------------------------------------------------------------

export interface YamlSearchResult {
    query: string;
    matches: YamlTreeNode[];
}

/**
 * Run a search across the tree. Sets `matched = true` on every node whose
 * key, primitive, anchor name, or alias name contains `query`
 * (case-insensitive). An empty / whitespace query clears matches.
 */
export function search(root: YamlTreeNode, rawQuery: string): YamlSearchResult {
    const query = rawQuery.trim().toLowerCase();
    clearMatches(root);
    if (!query) {
        return { query: '', matches: [] };
    }

    const matches: YamlTreeNode[] = [];
    walk(root, (n) => {
        if (nodeMatches(n, query)) {
            n.matched = true;
            matches.push(n);
        }
    });
    return { query, matches };
}

function nodeMatches(node: YamlTreeNode, lowerQuery: string): boolean {
    if (node.key.toLowerCase().includes(lowerQuery)) return true;
    if (node.primitive !== undefined && node.primitive.toLowerCase().includes(lowerQuery)) {
        return true;
    }
    if (node.anchor && node.anchor.toLowerCase().includes(lowerQuery)) return true;
    if (node.alias && node.alias.toLowerCase().includes(lowerQuery)) return true;
    return false;
}

/** Compute the next match index, wrapping at the ends. */
export function nextMatchIndex(current: number, total: number): number {
    if (total <= 0) return -1;
    if (current < 0) return 0;
    return (current + 1) % total;
}

/** Compute the previous match index, wrapping at the ends. */
export function prevMatchIndex(current: number, total: number): number {
    if (total <= 0) return -1;
    if (current < 0) return total - 1;
    return (current - 1 + total) % total;
}
