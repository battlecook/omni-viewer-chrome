// ElementManager — owns the list of edit-mode elements (text / circle / rect)
// and their DOM representations on the edit canvas.
//
// Chrome-side port of
// `vscode-omni-viewer/src/templates/image/js/ImageEditMode/managers/ElementManager.js`,
// scoped to issue #12:
//
//   - `create()` for the three element kinds (text / circle / rect)
//   - `getById()` / `list()` for read access
//   - `clear()` for bulk teardown
//   - `subscribe()` so future managers (#13 selection / #14 properties /
//     #15 save) can re-render or persist on element-list change
//   - `serialize()` so #15's save flow has a stable snapshot shape
//
// Out of scope here (deliberately deferred):
//   - selection / drag-drop (#13)
//   - resize handles + properties panel (#14)
//   - save (#15)
//
// Element data shape mirrors the spec in issue #12:
//   { id, type, x, y, w, h, text?, style: {...} }
//
// The "style" sub-object holds anything visually configurable today
// (color, opacity, fontSize, stroke, fill). Issue #14 will widen it as
// the properties panel lands; we keep keys optional so we don't have to
// rev the type when that happens.

/** Element kinds the manager knows how to render. */
export type ElementType = 'text' | 'circle' | 'rect';

/** Visual styling for an element. All keys optional — defaults applied at render time. */
export interface ElementStyle {
    /** Fill color in `#rrggbb`. Used as background for shapes / color for text. */
    fill?: string;
    /** Stroke color in `#rrggbb`. Border color for shapes; ignored for text. */
    stroke?: string;
    /** Stroke width in px. Defaults to 2 for shapes; ignored for text. */
    strokeWidth?: number;
    /** Opacity 0..1. Applied via the element's `opacity` style. */
    opacity?: number;
    /** Font size in px (text only). */
    fontSize?: number;
}

/** Stored shape for every element. Returned by `list()` / `serialize()`. */
export interface ElementData {
    /** Stable, unique id assigned at create time. Format: `el-<n>`. */
    id: string;
    /** Element kind. */
    type: ElementType;
    /** Top-left (or center for text) x in canvas-local px. */
    x: number;
    /** Top-left (or center for text) y in canvas-local px. */
    y: number;
    /** Width in px. For text, the rendered text box width. */
    w: number;
    /** Height in px. For text, the rendered text box height. */
    h: number;
    /** Text content (text elements only). */
    text?: string;
    /** Visual style. */
    style: ElementStyle;
}

/** Listener invoked whenever the element list mutates. */
export type ElementChangeListener = (elements: readonly ElementData[]) => void;

/**
 * Partial-update payload accepted by {@link ElementManager.update}. Issue #14
 * (resize + properties panel) pushes incremental edits through this surface.
 *
 * Geometry fields (x / y / w / h) are mutually independent — callers may pass
 * any subset. `text` is honored only on `text` elements (silently ignored
 * elsewhere). `style` is shallow-merged into the existing style object so
 * partial color/opacity/fontSize updates don't clobber unrelated keys.
 */
export interface ElementUpdate {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    text?: string;
    style?: Partial<ElementStyle>;
}

/** Options passed to `addText`. All fields optional except position. */
export interface AddTextOptions {
    x: number;
    y: number;
    text?: string;
    fontSize?: number;
    color?: string;
    opacity?: number;
}

/** Options passed to `addCircle` / `addRectangle`. */
export interface AddShapeOptions {
    x: number;
    y: number;
    w?: number;
    h?: number;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    opacity?: number;
}

/** Defaults applied when caller omits style fields. */
const DEFAULT_TEXT: Required<Pick<AddTextOptions, 'text' | 'fontSize' | 'color' | 'opacity'>> = {
    text: 'Text',
    fontSize: 24,
    color: '#ff3030',
    opacity: 1
};
const DEFAULT_SHAPE: Required<Pick<AddShapeOptions, 'w' | 'h' | 'fill' | 'stroke' | 'strokeWidth' | 'opacity'>> = {
    w: 100,
    h: 100,
    fill: '#ff3030',
    stroke: '#000000',
    strokeWidth: 2,
    opacity: 1
};

/** Z-index baseline so elements render above the underlying image / filters. */
const ELEMENT_BASE_Z_INDEX = 10000;

/** ElementManager construction options. */
export interface ElementManagerOptions {
    /**
     * Edit canvas DOM node. Created elements are appended here. May be
     * supplied later via `setCanvas()` if the canvas is constructed lazily
     * (matches `ToolManager`'s pattern).
     */
    canvas?: HTMLElement;
}

/**
 * Owns the in-memory list of edit-mode elements + their DOM nodes on the
 * edit canvas. Pure: no global queries, no module-level state.
 */
export class ElementManager {
    private canvas: HTMLElement | undefined;
    private readonly elements: ElementData[] = [];
    private readonly nodes = new Map<string, HTMLElement>();
    private readonly listeners = new Set<ElementChangeListener>();
    private nextId = 1;

    constructor(options: ElementManagerOptions = {}) {
        this.canvas = options.canvas;
    }

    // --- public API ------------------------------------------------------

    /** Late binding for the edit canvas. Existing nodes are re-parented. */
    setCanvas(canvas: HTMLElement | undefined): void {
        if (this.canvas === canvas) return;
        // Detach prior nodes from the old canvas (caller may want to dispose it).
        if (this.canvas) {
            for (const node of this.nodes.values()) {
                if (node.parentElement === this.canvas) {
                    this.canvas.removeChild(node);
                }
            }
        }
        this.canvas = canvas;
        if (canvas) {
            for (const data of this.elements) {
                const node = this.nodes.get(data.id);
                if (node) canvas.appendChild(node);
            }
        }
    }

    /** Read the current canvas. Useful for tests + future managers (#13). */
    getCanvas(): HTMLElement | undefined {
        return this.canvas;
    }

    /** Snapshot of the element list in z-order (back -> front). */
    list(): readonly ElementData[] {
        return this.elements.slice();
    }

    /** Number of elements currently tracked. */
    count(): number {
        return this.elements.length;
    }

    /** Lookup by id. Returns undefined when not present. */
    getById(id: string): ElementData | undefined {
        return this.elements.find((el) => el.id === id);
    }

    /** Lookup the DOM node for an element id. Useful for #13 selection. */
    getNode(id: string): HTMLElement | undefined {
        return this.nodes.get(id);
    }

    /**
     * Subscribe to element-list change events (create / clear). Returns an
     * unsubscribe fn matching the ToolManager subscribe contract.
     */
    subscribe(listener: ElementChangeListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Generic factory: pick the right `add*` based on `type`. Used by the
     * canvas-click handler in `ImageEditMode/index.ts` so we don't have to
     * branch on the tool name there.
     */
    create(
        type: ElementType,
        x: number,
        y: number,
        properties: Partial<AddTextOptions & AddShapeOptions> = {}
    ): ElementData {
        switch (type) {
            case 'text':
                return this.addText({
                    x,
                    y,
                    text: properties.text,
                    fontSize: properties.fontSize,
                    color: properties.color ?? properties.fill,
                    opacity: properties.opacity
                });
            case 'circle':
                return this.addCircle({
                    x,
                    y,
                    w: properties.w,
                    h: properties.h,
                    fill: properties.fill,
                    stroke: properties.stroke,
                    strokeWidth: properties.strokeWidth,
                    opacity: properties.opacity
                });
            case 'rect':
                return this.addRectangle({
                    x,
                    y,
                    w: properties.w,
                    h: properties.h,
                    fill: properties.fill,
                    stroke: properties.stroke,
                    strokeWidth: properties.strokeWidth,
                    opacity: properties.opacity
                });
            default: {
                // Exhaustiveness guard.
                const _never: never = type;
                throw new Error(`ElementManager.create: unknown type ${_never}`);
            }
        }
    }

    /** Create an absolutely-positioned text element. */
    addText(options: AddTextOptions): ElementData {
        const text = options.text ?? DEFAULT_TEXT.text;
        const fontSize = options.fontSize ?? DEFAULT_TEXT.fontSize;
        const color = options.color ?? DEFAULT_TEXT.color;
        const opacity = clamp01(options.opacity ?? DEFAULT_TEXT.opacity);

        // We don't know the rendered width until layout — store the font-size
        // approximation so serialize() has a stable shape. #14 will replace
        // this with `getBoundingClientRect()` once selection/resize land.
        const data: ElementData = {
            id: this.mintId(),
            type: 'text',
            x: options.x,
            y: options.y,
            w: Math.max(1, Math.round(text.length * fontSize * 0.6)),
            h: Math.max(1, Math.round(fontSize * 1.2)),
            text,
            style: { fill: color, fontSize, opacity }
        };

        const node = document.createElement('div');
        node.className = 'iv-edit-element iv-edit-text';
        node.dataset.elementId = data.id;
        node.dataset.elementType = 'text';
        node.textContent = text;
        applyBaseStyles(node, data);
        node.style.fontSize = `${fontSize}px`;
        node.style.color = color;
        node.style.opacity = String(opacity);

        this.commit(data, node);
        return data;
    }

    /** Create a circle (SVG inside an absolutely-positioned wrapper). */
    addCircle(options: AddShapeOptions): ElementData {
        return this.addShape('circle', options);
    }

    /** Create a rectangle (SVG inside an absolutely-positioned wrapper). */
    addRectangle(options: AddShapeOptions): ElementData {
        return this.addShape('rect', options);
    }

    /** Remove every element + its node. Fires listeners once. */
    clear(): void {
        if (this.elements.length === 0 && this.nodes.size === 0) {
            return;
        }
        for (const node of this.nodes.values()) {
            if (node.parentElement) {
                node.parentElement.removeChild(node);
            }
        }
        this.nodes.clear();
        this.elements.length = 0;
        this.nextId = 1;
        this.notify();
    }

    /**
     * Plain-data snapshot for #15's save flow. Returns a deep copy so callers
     * cannot mutate the manager's state by accident.
     */
    serialize(): ElementData[] {
        return this.elements.map((el) => ({
            ...el,
            style: { ...el.style }
        }));
    }

    /**
     * Apply a partial mutation to the element identified by `id`. Returns the
     * post-update {@link ElementData}, or `undefined` when the id is unknown.
     *
     * Geometry fields (x / y / w / h) update both the data record and the
     * inline DOM styles, and trigger a shape re-render for circle/rect so the
     * SVG geometry follows the new size. Style fields shallow-merge into
     * `data.style` and update fill/stroke/opacity/fontSize on the node /
     * SVG payload. `text` only applies to text elements.
     *
     * Listeners fire exactly once per call (only when at least one field
     * actually changed) so subscribers don't churn on no-op updates.
     */
    update(id: string, partial: ElementUpdate): ElementData | undefined {
        const data = this.getById(id);
        if (!data) return undefined;
        const node = this.nodes.get(id);

        let geometryChanged = false;
        let styleChanged = false;
        let textChanged = false;

        if (typeof partial.x === 'number' && partial.x !== data.x) {
            data.x = partial.x;
            geometryChanged = true;
        }
        if (typeof partial.y === 'number' && partial.y !== data.y) {
            data.y = partial.y;
            geometryChanged = true;
        }
        if (typeof partial.w === 'number') {
            const next = Math.max(1, Math.round(partial.w));
            if (next !== data.w) {
                data.w = next;
                geometryChanged = true;
            }
        }
        if (typeof partial.h === 'number') {
            const next = Math.max(1, Math.round(partial.h));
            if (next !== data.h) {
                data.h = next;
                geometryChanged = true;
            }
        }

        if (partial.style) {
            for (const key of Object.keys(partial.style) as (keyof ElementStyle)[]) {
                const value = partial.style[key];
                if (value === undefined) continue;
                if (data.style[key] !== value) {
                    // Cast through unknown — TS can't track that the key/value
                    // pair stays in sync across the loop.
                    (data.style as Record<string, unknown>)[key] = value;
                    styleChanged = true;
                }
            }
        }

        if (typeof partial.text === 'string' && data.type === 'text' && partial.text !== data.text) {
            data.text = partial.text;
            textChanged = true;
        }

        if (!geometryChanged && !styleChanged && !textChanged) {
            return data;
        }

        if (node) {
            if (geometryChanged) {
                node.style.left = `${data.x}px`;
                node.style.top = `${data.y}px`;
                node.style.width = `${data.w}px`;
                if (data.type !== 'text') {
                    node.style.height = `${data.h}px`;
                }
            }
            if (data.type === 'text') {
                if (textChanged) {
                    node.textContent = data.text ?? '';
                }
                if (styleChanged) {
                    if (typeof data.style.fill === 'string') {
                        node.style.color = data.style.fill;
                    }
                    if (typeof data.style.fontSize === 'number') {
                        node.style.fontSize = `${data.style.fontSize}px`;
                    }
                    if (typeof data.style.opacity === 'number') {
                        node.style.opacity = String(data.style.opacity);
                    }
                }
                // Text height is implicit (line-height) — recompute the
                // stored bounding-box approximation so future serialize() /
                // resize math keeps a sane h value.
                if (geometryChanged || textChanged || styleChanged) {
                    const fontSize = data.style.fontSize ?? 24;
                    const text = data.text ?? '';
                    if (!geometryChanged) {
                        // Only recompute when geometry isn't user-supplied.
                        data.w = Math.max(1, Math.round(text.length * fontSize * 0.6));
                        data.h = Math.max(1, Math.round(fontSize * 1.2));
                        node.style.width = `${data.w}px`;
                    }
                }
            } else {
                // Shape: rebuild SVG payload to follow the new geometry / style.
                if (geometryChanged || styleChanged) {
                    rebuildShapeSvg(node, data);
                }
                if (styleChanged && typeof data.style.opacity === 'number') {
                    node.style.opacity = String(data.style.opacity);
                }
            }
        }

        this.notify();
        return data;
    }

    /** Drop listeners + DOM nodes. Mirrors `ToolManager.dispose()`. */
    dispose(): void {
        this.clear();
        this.listeners.clear();
        this.canvas = undefined;
    }

    // --- helpers ---------------------------------------------------------

    /**
     * Shared circle/rect creation. Both shapes use an absolutely-positioned
     * wrapper holding an SVG so:
     *   - `data-element-id` on the wrapper still works for #13 hit testing,
     *   - the SVG carries the actual fill / stroke / opacity styles,
     *   - we don't have to fight CSS pixel snapping at sub-pixel widths.
     */
    private addShape(kind: 'circle' | 'rect', options: AddShapeOptions): ElementData {
        const w = Math.max(1, Math.round(options.w ?? DEFAULT_SHAPE.w));
        const h = Math.max(1, Math.round(options.h ?? (kind === 'circle' ? (options.w ?? DEFAULT_SHAPE.w) : DEFAULT_SHAPE.h)));
        const fill = options.fill ?? DEFAULT_SHAPE.fill;
        const stroke = options.stroke ?? DEFAULT_SHAPE.stroke;
        const strokeWidth = options.strokeWidth ?? DEFAULT_SHAPE.strokeWidth;
        const opacity = clamp01(options.opacity ?? DEFAULT_SHAPE.opacity);

        const data: ElementData = {
            id: this.mintId(),
            type: kind,
            x: options.x,
            y: options.y,
            w,
            h,
            style: { fill, stroke, strokeWidth, opacity }
        };

        const node = document.createElement('div');
        node.className = `iv-edit-element iv-edit-${kind}`;
        node.dataset.elementId = data.id;
        node.dataset.elementType = kind;
        applyBaseStyles(node, data);
        node.style.opacity = String(opacity);

        // SVG payload. Inline width/height match the wrapper exactly so the
        // shape fills the wrapper without overflow.
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(w));
        svg.setAttribute('height', String(h));
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.style.display = 'block';
        svg.style.overflow = 'visible';

        if (kind === 'circle') {
            const cx = w / 2;
            const cy = h / 2;
            // Use the smaller dimension for radius minus stroke so the shape
            // stays inside the bounding box even when stroke is thick.
            const r = Math.max(0, Math.min(w, h) / 2 - strokeWidth / 2);
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', String(cx));
            circle.setAttribute('cy', String(cy));
            circle.setAttribute('r', String(r));
            circle.setAttribute('fill', fill);
            circle.setAttribute('stroke', stroke);
            circle.setAttribute('stroke-width', String(strokeWidth));
            svg.appendChild(circle);
        } else {
            const half = strokeWidth / 2;
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', String(half));
            rect.setAttribute('y', String(half));
            rect.setAttribute('width', String(Math.max(0, w - strokeWidth)));
            rect.setAttribute('height', String(Math.max(0, h - strokeWidth)));
            rect.setAttribute('fill', fill);
            rect.setAttribute('stroke', stroke);
            rect.setAttribute('stroke-width', String(strokeWidth));
            svg.appendChild(rect);
        }

        node.appendChild(svg);
        this.commit(data, node);
        return data;
    }

    /** Push to elements/nodes, append to canvas, notify listeners. */
    private commit(data: ElementData, node: HTMLElement): void {
        node.style.zIndex = String(ELEMENT_BASE_Z_INDEX + this.elements.length);
        this.elements.push(data);
        this.nodes.set(data.id, node);
        if (this.canvas) {
            this.canvas.appendChild(node);
        }
        this.notify();
    }

    private mintId(): string {
        const id = `el-${this.nextId}`;
        this.nextId += 1;
        return id;
    }

    private notify(): void {
        const snapshot = this.elements.slice();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch (err) {
                // A misbehaving listener should not break the manager.
                // eslint-disable-next-line no-console
                console.error('ElementManager listener threw:', err);
            }
        }
    }
}

// --- internals -----------------------------------------------------------

/** Apply position + sizing + the absolute-positioning baseline. */
function applyBaseStyles(node: HTMLElement, data: ElementData): void {
    node.style.position = 'absolute';
    node.style.left = `${data.x}px`;
    node.style.top = `${data.y}px`;
    node.style.width = `${data.w}px`;
    if (data.type !== 'text') {
        node.style.height = `${data.h}px`;
    }
    // Centered on (x, y) — matches the VSCode original's translate(-50%, -50%).
    // #13 (drag-drop) relies on this so the click point becomes the element's
    // center; updating that contract here would force a #13 rewrite.
    node.style.transform = 'translate(-50%, -50%)';
    node.style.pointerEvents = 'auto';
    node.style.userSelect = 'none';
}

function clamp01(value: number): number {
    if (Number.isNaN(value)) return 1;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

/**
 * Replace a shape wrapper's SVG payload to reflect the current geometry
 * + style. Used by {@link ElementManager.update} so the rendered shape
 * tracks resize / fill / stroke / strokeWidth changes without rebuilding
 * the wrapper element (preserving id, class list, listeners).
 */
function rebuildShapeSvg(node: HTMLElement, data: ElementData): void {
    if (data.type === 'text') return;
    const w = Math.max(1, data.w);
    const h = Math.max(1, data.h);
    const fill = data.style.fill ?? '#ff3030';
    const stroke = data.style.stroke ?? '#000000';
    const strokeWidth = data.style.strokeWidth ?? 2;

    const existing = node.querySelector('svg');
    if (existing && existing.parentElement === node) {
        node.removeChild(existing);
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.style.display = 'block';
    svg.style.overflow = 'visible';

    if (data.type === 'circle') {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.max(0, Math.min(w, h) / 2 - strokeWidth / 2);
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', String(cx));
        circle.setAttribute('cy', String(cy));
        circle.setAttribute('r', String(r));
        circle.setAttribute('fill', fill);
        circle.setAttribute('stroke', stroke);
        circle.setAttribute('stroke-width', String(strokeWidth));
        svg.appendChild(circle);
    } else {
        const half = strokeWidth / 2;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(half));
        rect.setAttribute('y', String(half));
        rect.setAttribute('width', String(Math.max(0, w - strokeWidth)));
        rect.setAttribute('height', String(Math.max(0, h - strokeWidth)));
        rect.setAttribute('fill', fill);
        rect.setAttribute('stroke', stroke);
        rect.setAttribute('stroke-width', String(strokeWidth));
        svg.appendChild(rect);
    }

    node.appendChild(svg);
}
