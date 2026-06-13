// Pure visibility reducer + layer tree shape for the PSD viewer
// (issue #51).
//
// This module is deliberately DOM-free so the visibility math can be
// unit-tested without jsdom canvases. The orchestration layer
// (`psdViewerMain.ts`) consumes the helpers here to wire the layer
// panel into the live viewer.
//
// Key design decisions:
//
//   - We DON'T mutate the visibility map in place inside
//     `toggleVisibility` / `propagateGroupToggle`. Both return a new
//     `VisibilityMap`, so the caller gets value-semantics and tests
//     can compare snapshots.
//   - Layer identity uses a stable PATH (string) per node, built from
//     sibling indices ("0/2/1"). ag-psd does NOT provide stable layer
//     ids across reloads, so the path is the simplest reproducible
//     key. As a bonus, paths give a natural prefix relation we use
//     for descendant propagation.
//   - The reducer is the source of truth for "effective visibility";
//     a leaf is visible iff every ancestor (including itself) is
//     visible. This is what callers use to drive the composite
//     re-render.

/* eslint-disable @typescript-eslint/no-explicit-any */
// Justification: ag-psd ships no TypeScript declarations. The
// `RawAgPsdLayer` shape below is a structural subset of what ag-psd
// surfaces; we keep the rest of the layer object as `any` at the
// boundary and narrow at each call site.

/** Subset of an ag-psd layer node we depend on. */
export interface RawAgPsdLayer {
    name?: string;
    hidden?: boolean;
    left?: number;
    top?: number;
    right?: number;
    bottom?: number;
    canvas?: HTMLCanvasElement;
    imageData?: ImageData;
    children?: RawAgPsdLayer[];
}

/**
 * Flattened representation of a single layer node, with enough info
 * to render the layer-panel row and to participate in the composite
 * redraw.
 *
 * `path` is the stable id used everywhere — both as the key into
 * `VisibilityMap` and as the prefix-relation for descendant
 * propagation.
 */
export interface LayerNode {
    /** Stable id ("0/2/1") built from sibling indices. */
    path: string;
    /** Sibling index relative to the parent. */
    index: number;
    /** 0 for top-level nodes; +1 per nesting level. */
    depth: number;
    /** Display label for the panel row. */
    name: string;
    /** Whether this node has at least one child layer. */
    isGroup: boolean;
    /** Whether ag-psd materialized a canvas/imageData for this leaf. */
    hasPixels: boolean;
    /** Raw ag-psd reference (for composite redraw — `canvas` / bounds). */
    raw: RawAgPsdLayer;
}

/**
 * Map of `LayerNode.path` -> visible-flag. A node missing from the
 * map is treated as visible (so callers can lazy-init only the rows
 * the user has actually toggled).
 */
export type VisibilityMap = Record<string, boolean>;

/**
 * Walk the ag-psd `psd.children` tree and produce a flat array in
 * draw order (top-of-list first, like the Photoshop layer panel —
 * NOT the bottom-to-top draw order; that conversion happens in the
 * composite step).
 *
 * Group nodes are emitted before their children so the panel can
 * render an indented tree by reading the array linearly and using
 * `node.depth` for indentation.
 */
export function walkLayers(
    nodes: RawAgPsdLayer[] | undefined,
    parentPath = '',
    depth = 0,
    out: LayerNode[] = []
): LayerNode[] {
    if (!nodes || !nodes.length) return out;
    for (let i = 0; i < nodes.length; i++) {
        const raw = nodes[i];
        const path = parentPath === '' ? String(i) : `${parentPath}/${i}`;
        const children = raw.children;
        const isGroup = Array.isArray(children) && children.length > 0;
        const hasPixels = !!(raw.canvas || raw.imageData);
        out.push({
            path,
            index: i,
            depth,
            name: raw.name && raw.name.trim().length > 0
                ? raw.name
                : `Layer ${i + 1}`,
            isGroup,
            hasPixels,
            raw
        });
        if (isGroup) {
            walkLayers(children, path, depth + 1, out);
        }
    }
    return out;
}

/**
 * Initial visibility map: every node defaults to `!hidden`. ag-psd
 * surfaces the Photoshop "eye-icon off" state via `layer.hidden`, so
 * we honor it on first mount.
 */
export function buildInitialVisibility(layers: LayerNode[]): VisibilityMap {
    const map: VisibilityMap = {};
    for (const node of layers) {
        map[node.path] = node.raw.hidden !== true;
    }
    return map;
}

/**
 * Read a node's own visible flag. A path missing from the map is
 * treated as visible — this matches the "lazy-init" contract above.
 */
export function isNodeVisible(map: VisibilityMap, path: string): boolean {
    if (Object.prototype.hasOwnProperty.call(map, path)) {
        return map[path];
    }
    return true;
}

/**
 * Effective visibility: a node is effectively visible iff its own
 * flag is true AND every ancestor's flag is true. This is what the
 * composite redraw uses to decide whether to draw a leaf.
 *
 * Implementation walks the path segments (`"0/2/1"` -> `["0", "0/2", "0/2/1"]`)
 * and short-circuits on the first hidden ancestor.
 */
export function effectiveVisibility(map: VisibilityMap, path: string): boolean {
    if (!path) return true;
    const segments = path.split('/');
    let prefix = '';
    for (let i = 0; i < segments.length; i++) {
        prefix = prefix === '' ? segments[i] : `${prefix}/${segments[i]}`;
        if (!isNodeVisible(map, prefix)) return false;
    }
    return true;
}

/**
 * Toggle a single node's own visible flag. Returns a NEW map; the
 * input is not mutated. Group propagation lives in
 * `propagateGroupToggle` — this helper does NOT cascade.
 */
export function toggleVisibility(map: VisibilityMap, path: string): VisibilityMap {
    const next = { ...map };
    next[path] = !isNodeVisible(map, path);
    return next;
}

/**
 * Toggle a group node and propagate the new state to every
 * descendant in the flattened layer list. We use the path-prefix
 * relation: any node whose `path` starts with `groupPath + "/"` is a
 * descendant.
 *
 * Returns a NEW map; the input is not mutated.
 *
 * If `groupPath` is not actually a group (no descendants in
 * `layers`), we still flip the node itself — callers can use this
 * helper unconditionally without checking `isGroup` first.
 */
export function propagateGroupToggle(
    layers: LayerNode[],
    map: VisibilityMap,
    groupPath: string
): VisibilityMap {
    const nextValue = !isNodeVisible(map, groupPath);
    const next: VisibilityMap = { ...map };
    next[groupPath] = nextValue;
    const prefix = `${groupPath}/`;
    for (const node of layers) {
        if (node.path.startsWith(prefix)) {
            next[node.path] = nextValue;
        }
    }
    return next;
}

/**
 * Filter a flattened layer list down to the leaves that should be
 * drawn into the composite (effectively visible AND have pixel
 * data). Returns them in DRAW ORDER — bottom-to-top — which is the
 * reverse of the panel order.
 *
 * The composite step is a tight `for` loop over this array; the
 * reducer side has already done the ancestor walk so the loop body
 * stays a single `ctx.drawImage` call.
 */
export function selectVisibleLeavesInDrawOrder(
    layers: LayerNode[],
    map: VisibilityMap
): LayerNode[] {
    const result: LayerNode[] = [];
    for (const node of layers) {
        if (node.isGroup) continue;
        if (!node.hasPixels) continue;
        if (!effectiveVisibility(map, node.path)) continue;
        result.push(node);
    }
    // Panel order is top-first; PSD draw order is bottom-first.
    return result.reverse();
}
