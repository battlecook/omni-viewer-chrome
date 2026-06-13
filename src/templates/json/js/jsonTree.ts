// Pure tree state + search reducer for the JSON viewer (issue #62).
//
// This module is intentionally DOM-free. It owns:
//
//   1. A `TreeNode` shape that mirrors the original JSON, with each node
//      carrying its own collapse / match / lazy-render flags so the
//      orchestrator can update DOM in O(visible-nodes) without touching
//      the underlying data.
//   2. Pure state transitions (`expand`, `collapse`, `expandAncestorsOf`,
//      `clearMatches`).
//   3. A search reducer (`search(root, query) -> SearchResult`) that walks
//      the tree once, collects every node whose key/primitive value
//      contains the query (case-insensitive), and returns those nodes in
//      depth-first order so the caller can step through with `n` / `Enter`
//      / `Shift+Enter`.
//
// All functions are unit-tested in `src/__tests__/jsonTree.test.ts`. The
// orchestrator is allowed to mutate `node.expanded` / `node.matched`
// directly — the test suite covers the helpers that perform those
// mutations through the documented API.

/**
 * Discriminator for the JSON value attached to a node. We split objects
 * and arrays out from primitives because the renderer treats them
 * differently (toggle vs. leaf) and search behaves differently too
 * (objects/arrays match by key, primitives match by stringified value).
 */
export type JsonValueKind =
    | 'object'
    | 'array'
    | 'string'
    | 'number'
    | 'boolean'
    | 'null';

/**
 * Tree node in the parsed-JSON tree. The orchestrator builds a `TreeNode`
 * graph once per file from the parsed JSON and then mutates the
 * `expanded` / `matched` flags as the user interacts. `children` is
 * always present for object/array kinds (possibly empty), and always
 * `undefined` for primitive kinds.
 *
 * The `path` array is the chain of keys / indices from the root, useful
 * for unique IDs and for tests that assert which nodes matched. `parent`
 * is a back-reference so `expandAncestorsOf` can run in O(depth) per
 * node without re-traversing from the root.
 */
export interface TreeNode {
    /** Display key for this node (root uses `'$'`). */
    key: string;
    /** Path from the root, in order. The root's path is `[]`. */
    path: ReadonlyArray<string | number>;
    /** Discriminated kind of the underlying JSON value. */
    kind: JsonValueKind;
    /**
     * For primitive kinds, the JSON-stringified value (so `"foo"` keeps
     * its quotes and `null` reads as `null`). Undefined for containers.
     */
    primitive?: string;
    /** Children for containers; undefined for primitives. */
    children?: TreeNode[];
    /** True iff this node should render its children. Default: root only. */
    expanded: boolean;
    /** True iff this node matched the most recent search query. */
    matched: boolean;
    /** Back-reference for fast ancestor walks. Root's parent is `null`. */
    parent: TreeNode | null;
}

export interface BuildTreeOptions {
    /** Optional override for the root node's display key. Defaults to `'$'`. */
    rootKey?: string;
    /** Whether the root is initially expanded. Defaults to `true`. */
    expandRoot?: boolean;
}

/**
 * Build a `TreeNode` tree from a parsed JSON value. Containers default
 * to collapsed (so 10MB JSON does not pay the lazy-render cost up front);
 * the root is expanded by default so the user always sees the first
 * level of structure.
 */
export function buildTree(value: unknown, options: BuildTreeOptions = {}): TreeNode {
    const rootKey = options.rootKey ?? '$';
    const expandRoot = options.expandRoot ?? true;
    return buildNode(value, rootKey, [], null, expandRoot);
}

function buildNode(
    value: unknown,
    key: string,
    path: ReadonlyArray<string | number>,
    parent: TreeNode | null,
    initiallyExpanded: boolean
): TreeNode {
    const kind = detectKind(value);
    const node: TreeNode = {
        key,
        path,
        kind,
        expanded: initiallyExpanded,
        matched: false,
        parent
    };

    if (kind === 'object') {
        const obj = value as Record<string, unknown>;
        const children: TreeNode[] = [];
        for (const childKey of Object.keys(obj)) {
            children.push(
                buildNode(obj[childKey], childKey, [...path, childKey], node, false)
            );
        }
        node.children = children;
    } else if (kind === 'array') {
        const arr = value as unknown[];
        const children: TreeNode[] = [];
        for (let i = 0; i < arr.length; i++) {
            children.push(
                buildNode(arr[i], String(i), [...path, i], node, false)
            );
        }
        node.children = children;
    } else {
        node.primitive = stringifyPrimitive(value, kind);
    }

    return node;
}

function detectKind(value: unknown): JsonValueKind {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    const t = typeof value;
    if (t === 'object') return 'object';
    if (t === 'string') return 'string';
    if (t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    // `undefined` / functions can't survive JSON.parse, but be defensive.
    return 'null';
}

function stringifyPrimitive(value: unknown, kind: JsonValueKind): string {
    if (kind === 'null') return 'null';
    if (kind === 'string') return JSON.stringify(value);
    return String(value);
}

// ---------------------------------------------------------------------------
// Pure mutators used by both the orchestrator and the tests.
// ---------------------------------------------------------------------------

/** Mark `node` as expanded. No-op for primitives. Returns `node`. */
export function expand(node: TreeNode): TreeNode {
    if (isContainer(node)) {
        node.expanded = true;
    }
    return node;
}

/** Mark `node` as collapsed. No-op for primitives. Returns `node`. */
export function collapse(node: TreeNode): TreeNode {
    if (isContainer(node)) {
        node.expanded = false;
    }
    return node;
}

/** Toggle expanded state. No-op for primitives. Returns the new state. */
export function toggle(node: TreeNode): boolean {
    if (!isContainer(node)) return node.expanded;
    node.expanded = !node.expanded;
    return node.expanded;
}

export function isContainer(node: TreeNode): boolean {
    return node.kind === 'object' || node.kind === 'array';
}

/**
 * Walk parents of every node in `matches` and set `expanded = true` on
 * each ancestor, so the matching nodes become visible in the tree. The
 * matched nodes themselves are NOT expanded — the caller may still want
 * to scroll to them while keeping their children collapsed. Returns the
 * Set of nodes whose `expanded` flag actually changed (useful for the
 * DOM layer to know which subtrees need to be rendered for the first
 * time).
 */
export function expandAncestorsOf(matches: ReadonlyArray<TreeNode>): Set<TreeNode> {
    const changed = new Set<TreeNode>();
    for (const match of matches) {
        let cursor: TreeNode | null = match.parent;
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
export function clearMatches(root: TreeNode): void {
    walk(root, (n) => {
        n.matched = false;
    });
}

/** Depth-first traversal helper, public so tests can assert ordering. */
export function walk(node: TreeNode, visit: (n: TreeNode) => void): void {
    visit(node);
    if (node.children) {
        for (const child of node.children) {
            walk(child, visit);
        }
    }
}

// ---------------------------------------------------------------------------
// Search reducer.
// ---------------------------------------------------------------------------

export interface SearchResult {
    /** Trimmed lower-cased query. Empty string means "no active search". */
    query: string;
    /** Matched nodes in depth-first traversal order. */
    matches: TreeNode[];
}

/**
 * Run a search across the tree. Side effects:
 *   - sets `matched = true` on every node whose key OR primitive value
 *     contains `query` (case-insensitive),
 *   - clears `matched` everywhere else (so re-running search doesn't
 *     keep stale highlights).
 *
 * Auto-expand of ancestors is intentionally NOT done here; the caller is
 * expected to feed `result.matches` into `expandAncestorsOf`. Splitting
 * the two steps keeps the reducer composable: tests can verify the
 * matching set without also asserting on the expanded set.
 *
 * An empty / whitespace query clears matches and returns `matches: []`.
 */
export function search(root: TreeNode, rawQuery: string): SearchResult {
    const query = rawQuery.trim().toLowerCase();
    clearMatches(root);
    if (!query) {
        return { query: '', matches: [] };
    }

    const matches: TreeNode[] = [];
    walk(root, (n) => {
        if (nodeMatches(n, query)) {
            n.matched = true;
            matches.push(n);
        }
    });

    return { query, matches };
}

function nodeMatches(node: TreeNode, lowerQuery: string): boolean {
    if (node.key.toLowerCase().includes(lowerQuery)) {
        return true;
    }
    if (node.primitive !== undefined) {
        if (node.primitive.toLowerCase().includes(lowerQuery)) {
            return true;
        }
    }
    return false;
}

/**
 * Compute the next match index after `current`. Wraps around at the
 * ends. Returns `0` when `current` is `-1` (no current match). When
 * `matches` is empty, returns `-1`.
 */
export function nextMatchIndex(current: number, total: number): number {
    if (total <= 0) return -1;
    if (current < 0) return 0;
    return (current + 1) % total;
}

/** Mirror of `nextMatchIndex` for the `prev` direction. */
export function prevMatchIndex(current: number, total: number): number {
    if (total <= 0) return -1;
    if (current < 0) return total - 1;
    return (current - 1 + total) % total;
}
