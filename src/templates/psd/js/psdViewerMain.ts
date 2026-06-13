// Orchestration layer for the Chrome PSD viewer (issue #50).
//
// Wires together:
//   - DOM scaffolding (header / metadata bar / canvas viewport / states),
//   - the ag-psd lazy loader (`./psdLoader.ts`),
//   - the composite-canvas mount.
//
// VSCode -> Chrome substitutions follow the same rules as #16 / #33:
//   - the file is a `File` from the router; we call
//     `await file.arrayBuffer()` (inside `parsePsdFromFile`) instead of
//     reading from disk via `fs`;
//   - the vendor bundle URL is `chrome.runtime.getURL('vendor/ag-psd.min.js')`
//     (resolved inside `psdLoader.ts`);
//   - `vscode.postMessage` is dropped; errors land in the inline error panel.
//
// Layer panel (#51) and view modal (#52) layer on top of #50.

import { PSD_VIEWER_CSS } from './psdViewerStyles';
import {
    parsePsdFromFile,
    formatColorMode,
    isPsdSizeAcceptable,
    buildPsdSizeRejectionMessage,
    ParsedPsd
} from './psdLoader';
import {
    LayerNode,
    VisibilityMap,
    walkLayers,
    buildInitialVisibility,
    isNodeVisible,
    propagateGroupToggle,
    selectVisibleLeavesInDrawOrder,
    toggleVisibility
} from './psdLayers';
import { openLayerView, PsdLayerModalHandle } from './psdViewModal';

const STYLE_ELEMENT_ID = 'omni-viewer-psd-styles';

function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = PSD_VIEWER_CSS;
    document.head.appendChild(style);
}

interface PsdViewerDom {
    root: HTMLElement;
    title: HTMLElement;
    meta: HTMLElement;
    body: HTMLElement;
    loading: HTMLElement;
    error: HTMLElement;
    warning: HTMLElement;
    main: HTMLElement;
    sidebar: HTMLElement;
    layerTree: HTMLElement;
}

export interface PsdViewerHandle {
    dispose(): void;
}

const VIEWER_HTML = /* html */ `
<div class="psv-container" data-psd-viewer-root>
    <div class="psv-header">
        <div class="psv-title" data-psv-title></div>
        <div class="psv-meta" id="psv-meta"></div>
    </div>
    <div id="psv-loading" class="psv-loading">Loading PSD…</div>
    <div id="psv-warning" class="psv-warning" style="display: none;"></div>
    <div id="psv-error" class="psv-error" style="display: none;"></div>
    <div id="psv-main" class="psv-main" style="display: none;">
        <aside id="psv-sidebar" class="psv-sidebar">
            <div class="psv-sidebar-header">Layers</div>
            <div id="psv-layer-tree" class="psd-layer-tree" role="tree"></div>
        </aside>
        <div id="psv-body" class="psv-body"></div>
    </div>
</div>
`;

function resolveDom(container: HTMLElement): PsdViewerDom {
    const need = <T extends HTMLElement>(id: string): T => {
        const el = container.querySelector<T>(`#${id}`);
        if (!el) throw new Error(`psd viewer: missing DOM node #${id}`);
        return el;
    };
    const root = container.querySelector<HTMLElement>('[data-psd-viewer-root]');
    if (!root) throw new Error('psd viewer: failed to mount root element');
    const title = root.querySelector<HTMLElement>('[data-psv-title]');
    if (!title) throw new Error('psd viewer: missing title slot');
    return {
        root,
        title,
        meta: need('psv-meta'),
        body: need('psv-body'),
        loading: need('psv-loading'),
        error: need('psv-error'),
        warning: need('psv-warning'),
        main: need('psv-main'),
        sidebar: need('psv-sidebar'),
        layerTree: need('psv-layer-tree')
    };
}

/**
 * Build a metadata row: `<label>: <value>`. Pure DOM helper; exported for
 * potential reuse by issue #51 when the layer panel needs the same
 * label-value pattern.
 */
function appendMetaItem(meta: HTMLElement, label: string, value: string): void {
    const item = document.createElement('span');
    item.className = 'psv-meta-item';
    const lbl = document.createElement('span');
    lbl.className = 'psv-meta-label';
    lbl.textContent = `${label}:`;
    const val = document.createElement('span');
    val.className = 'psv-meta-value';
    val.textContent = value;
    item.append(lbl, val);
    meta.appendChild(item);
}

/**
 * Render the metadata bar from a parsed PSD. Exported so `psdViewer.ts`
 * (entry / self-bootstrap) can reuse the same renderer.
 */
export function renderPsdMeta(meta: HTMLElement, psd: ParsedPsd): void {
    meta.innerHTML = '';
    appendMetaItem(meta, 'Size', `${psd.width} × ${psd.height}`);
    appendMetaItem(meta, 'Mode', formatColorMode(psd.colorMode));
    if (typeof psd.channels === 'number') {
        appendMetaItem(meta, 'Channels', String(psd.channels));
    }
    if (typeof psd.bitsPerChannel === 'number') {
        appendMetaItem(meta, 'Bits', `${psd.bitsPerChannel}/ch`);
    }
}

/**
 * Quick check used by the composite redraw fast-path: are every
 * tracked node's own flag true? When this is true we can re-use
 * ag-psd's pre-merged composite canvas (`psd.canvas`) directly,
 * which is both faster and pixel-perfect.
 */
function allNodesVisible(layers: LayerNode[], map: VisibilityMap): boolean {
    for (const node of layers) {
        if (!isNodeVisible(map, node.path)) return false;
    }
    return true;
}

/**
 * Render the layer panel from a flat layer list + the current
 * visibility map. Idempotent: callers re-invoke after every toggle
 * so the eye-icon state stays in sync with the reducer.
 *
 * Each row carries `data-psv-toggle`, `data-psv-path`, and
 * `data-psv-group` so the orchestration layer can wire a single
 * delegated click handler without per-row event listeners.
 *
 * Each non-group leaf with pixels also carries a `data-psv-view`
 * button (issue #52) that opens the single-layer view modal. Groups
 * and pixel-less leaves get a disabled button so the row layout
 * stays consistent (no horizontal jitter as the user scrolls /
 * collapses things).
 */
function renderLayerTree(
    host: HTMLElement,
    layers: LayerNode[],
    map: VisibilityMap
): void {
    host.innerHTML = '';
    if (!layers.length) {
        const empty = document.createElement('div');
        empty.className = 'psd-layer-tree-empty';
        empty.textContent = 'No layers';
        host.appendChild(empty);
        return;
    }
    for (const node of layers) {
        const ownVisible = isNodeVisible(map, node.path);
        const row = document.createElement('div');
        row.className = 'psd-layer-row' + (node.isGroup ? ' is-group' : '');
        // Indent purely with padding so the eye icon stays aligned
        // across depths.
        row.style.paddingLeft = `${8 + node.depth * 14}px`;

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'psd-layer-eye' + (ownVisible ? '' : ' is-hidden');
        toggle.setAttribute('data-psv-toggle', '1');
        toggle.setAttribute('data-psv-path', node.path);
        toggle.setAttribute('data-psv-group', node.isGroup ? '1' : '0');
        toggle.setAttribute(
            'aria-label',
            ownVisible ? `Hide ${node.name}` : `Show ${node.name}`
        );
        // Use an inline SVG so the icon renders without a font /
        // emoji fallback and so the "hidden" state can be styled via
        // CSS opacity + a slash overlay.
        toggle.innerHTML = ownVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;

        const label = document.createElement('span');
        label.className = 'psd-layer-name';
        label.title = node.name;
        label.textContent = node.name;

        // View button (issue #52): only meaningful for leaves that
        // actually have pixel data. Group nodes and pixel-less leaves
        // would open an empty checkerboard, which is misleading — so
        // we render the slot but disable it.
        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'psd-layer-view';
        const canView = !node.isGroup && node.hasPixels;
        viewBtn.setAttribute('data-psv-view', '1');
        viewBtn.setAttribute('data-psv-path', node.path);
        viewBtn.setAttribute(
            'aria-label',
            canView ? `View ${node.name}` : `${node.name} has no pixel data`
        );
        viewBtn.title = canView
            ? `View "${node.name}"`
            : 'No pixel data to view';
        viewBtn.disabled = !canView;
        viewBtn.textContent = '👁';

        row.append(toggle, label, viewBtn);
        host.appendChild(row);
    }
}

/**
 * Inline eye / eye-slash icons. Tiny, monochrome, sized to match
 * the row height. Kept as constants so `renderLayerTree` stays a
 * single allocation per row.
 */
const EYE_OPEN_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path fill="currentColor" d="M8 3.5C4.5 3.5 1.7 6 .8 8c.9 2 3.7 4.5 7.2 4.5S14.3 10 15.2 8C14.3 6 11.5 3.5 8 3.5zm0 7.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/>' +
    '</svg>';

const EYE_CLOSED_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path fill="currentColor" d="M2.1 2.1l11.8 11.8-1 1-2.2-2.2A8.7 8.7 0 0 1 8 12.5C4.5 12.5 1.7 10 .8 8a9 9 0 0 1 2.6-3.1L1.1 3.1l1-1zM8 5a3 3 0 0 1 3 3c0 .4-.1.8-.2 1.1l-3.9-3.9c.3-.1.7-.2 1.1-.2zm0 6a3 3 0 0 1-3-3c0-.5.1-.9.3-1.3l4 4c-.4.2-.8.3-1.3.3z"/>' +
    '</svg>';

/**
 * Mount the PSD viewer into `container`. Returns synchronously with a
 * handle whose `dispose()` cleans up; the actual ag-psd parse happens in
 * the background and the loading / error UI reacts to it.
 */
export function mountPsdViewer(file: File, container: HTMLElement): PsdViewerHandle {
    ensureStylesInjected();
    container.innerHTML = VIEWER_HTML;

    const dom = resolveDom(container);
    dom.title.textContent = file.name;

    let disposed = false;
    let mountedCanvas: HTMLCanvasElement | undefined;
    // Tracks the currently-open layer view modal (#52). At most one
    // modal is open at a time; opening another replaces it. Cleared
    // automatically via the modal's `onClose` hook.
    let activeModal: PsdLayerModalHandle | undefined;

    // ----- 200 MB memory gate ------------------------------------------
    // The DoD calls this out explicitly: refuse oversized PSDs so the tab
    // doesn't OOM on a single mount. We render a friendly warning panel
    // (not a hard error) because the file itself is fine — we're just
    // declining to allocate.
    if (!isPsdSizeAcceptable(file.size)) {
        dom.loading.style.display = 'none';
        dom.warning.style.display = 'flex';
        const headline = document.createElement('div');
        headline.textContent = 'PSD too large to open';
        const detail = document.createElement('div');
        detail.className = 'psv-warning-detail';
        detail.textContent = buildPsdSizeRejectionMessage(file.size);
        dom.warning.append(headline, detail);
        return {
            dispose(): void {
                disposed = true;
            }
        };
    }

    // ----- async parse + render ----------------------------------------
    void (async () => {
        try {
            const psd = await parsePsdFromFile(file);
            if (disposed) return;

            renderPsdMeta(dom.meta, psd);

            // The composite produced by ag-psd is the "all visible"
            // canvas. We mount it inside a fixed wrapper so the
            // box-shadow + max-width clamp behave consistently
            // regardless of viewport size, and stash a reference for
            // the redraw path triggered by layer-visibility toggles.
            dom.body.innerHTML = '';
            const wrapper = document.createElement('div');
            wrapper.className = 'psv-canvas-wrapper';
            const compositeCanvas = document.createElement('canvas');
            compositeCanvas.width = psd.width;
            compositeCanvas.height = psd.height;
            const compositeCtx = compositeCanvas.getContext('2d');
            if (!compositeCtx) {
                throw new Error('PSD: failed to acquire 2D context for composite canvas');
            }
            // First paint: draw the ag-psd composite as-is.
            compositeCtx.drawImage(psd.canvas, 0, 0);
            wrapper.appendChild(compositeCanvas);
            dom.body.appendChild(wrapper);
            mountedCanvas = compositeCanvas;

            // Build the flat layer list from the ag-psd tree. Empty
            // documents (no layers, just a background) render only
            // the composite image and the panel stays empty.
            const layers = walkLayers(psd.children);
            let visibility: VisibilityMap = buildInitialVisibility(layers);

            // -- Re-composite path --
            //
            // Triggered on every visibility toggle. We clear and
            // redraw from `psd.canvas` (the ag-psd composite) when
            // every node is currently visible — that keeps the very
            // common "no toggles yet" case fast and avoids a slight
            // visual delta vs the merged composite. Otherwise we
            // walk the visible leaves bottom-to-top and stamp each
            // one at its (left, top).
            const renderComposite = (): void => {
                if (disposed) return;
                compositeCtx.clearRect(0, 0, psd.width, psd.height);
                if (allNodesVisible(layers, visibility)) {
                    compositeCtx.drawImage(psd.canvas, 0, 0);
                    return;
                }
                const drawList = selectVisibleLeavesInDrawOrder(layers, visibility);
                for (const leaf of drawList) {
                    const left = leaf.raw.left ?? 0;
                    const top = leaf.raw.top ?? 0;
                    if (leaf.raw.canvas) {
                        compositeCtx.drawImage(leaf.raw.canvas, left, top);
                    } else if (leaf.raw.imageData) {
                        // Some ag-psd builds surface ImageData instead of a
                        // canvas. `putImageData` ignores transform/composite,
                        // so we only fall back here when there's no canvas.
                        compositeCtx.putImageData(leaf.raw.imageData, left, top);
                    }
                }
            };

            // -- Toggle handler --
            //
            // Wired as a single delegated listener on the layer-tree
            // root so we don't have to re-attach per-row when the
            // tree re-renders.
            const handleToggle = (path: string, isGroup: boolean): void => {
                visibility = isGroup
                    ? propagateGroupToggle(layers, visibility, path)
                    : toggleVisibility(visibility, path);
                renderLayerTree(dom.layerTree, layers, visibility);
                renderComposite();
            };

            // -- View handler (#52) --
            //
            // Opens the single-layer modal for a leaf with pixel data.
            // The modal is responsible for its own ESC / overlay-click
            // close flow; we just track the handle so we can dispose
            // it during the host viewer's own teardown.
            const handleView = (path: string): void => {
                const node = layers.find((n) => n.path === path);
                if (!node || node.isGroup || !node.hasPixels) return;
                const layerCanvas = node.raw.canvas;
                if (!layerCanvas) return;
                // Replace any existing modal so the user always sees
                // the most recently clicked layer.
                activeModal?.dispose();
                activeModal = openLayerView(layerCanvas, node.name, {
                    onClose: () => {
                        activeModal = undefined;
                    }
                });
            };

            renderLayerTree(dom.layerTree, layers, visibility);
            dom.layerTree.addEventListener('click', (event) => {
                const target = event.target as HTMLElement | null;
                if (!target) return;
                // View button takes precedence — it sits inside the
                // layer row so a naive `closest('[data-psv-toggle]')`
                // would never match it, but we keep the lookup
                // explicit for clarity.
                const viewBtn = target.closest<HTMLElement>('[data-psv-view]');
                if (viewBtn && dom.layerTree.contains(viewBtn)) {
                    if ((viewBtn as HTMLButtonElement).disabled) return;
                    const path = viewBtn.getAttribute('data-psv-path');
                    if (path === null) return;
                    handleView(path);
                    return;
                }
                const btn = target.closest<HTMLElement>('[data-psv-toggle]');
                if (!btn || !dom.layerTree.contains(btn)) return;
                const path = btn.getAttribute('data-psv-path');
                if (path === null) return;
                const isGroup = btn.getAttribute('data-psv-group') === '1';
                handleToggle(path, isGroup);
            });

            dom.loading.style.display = 'none';
            dom.main.style.display = 'flex';
            dom.body.style.display = 'flex';
        } catch (err) {
            if (disposed) return;
            const message = err instanceof Error ? err.message : String(err);
            dom.loading.style.display = 'none';
            dom.error.style.display = 'flex';
            const headline = document.createElement('div');
            headline.textContent = 'Failed to load PSD';
            const detail = document.createElement('div');
            detail.className = 'psv-error-detail';
            detail.textContent = message;
            dom.error.append(headline, detail);
        }
    })();

    return {
        dispose(): void {
            disposed = true;
            // Tear down any open layer view modal so its ESC/overlay
            // listeners don't leak past the host viewer's lifetime.
            activeModal?.dispose();
            activeModal = undefined;
            // Best-effort: drop the canvas reference so the GC can reclaim
            // the (potentially large) backing store as soon as the host
            // clears the container.
            if (mountedCanvas) {
                mountedCanvas.width = 0;
                mountedCanvas.height = 0;
                mountedCanvas = undefined;
            }
        }
    };
}
