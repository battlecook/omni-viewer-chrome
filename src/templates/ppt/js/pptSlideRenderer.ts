// DOM rendering for parsed PPTX slides (issue #46).
//
// Each slide is rendered as an absolutely-positioned `<div class="pv-slide-frame">`
// whose intrinsic CSS size is the slide width/height in pixels (as parsed
// from `<p:sldSz>`). The viewer mounts a wrapper around this frame and
// applies `transform: scale(...)` so the slide fits the viewport — the
// pixel coordinates inside the frame stay in their original PPTX units.
//
// Each shape is also absolutely-positioned. The discriminated union from
// `pptxXmlParser` decides what to render:
//   - `text`        — paragraph nodes (run-level styling when present),
//                     larger font for `isTitle`.
//   - `picture`     — `<img>` whose `src` comes from a `URL.createObjectURL`
//                     of the embedded media bytes (resolved via the parser's
//                     pictureTarget + the JSZip handle).
//   - `placeholder` — empty styled box (background / border) so layout art
//                     survives even without text.
//
// Picture URLs are tracked in a `Set<string>` and revoked on dispose so the
// blobs don't leak when the user switches files.

import type {
    PptxDocument,
    PptxParagraph,
    PptxRun,
    PptxShape,
    PptxSlide,
    PptxZip
} from '../../../utils/pptxXmlParser';
import type {
    PptPictureAsset,
    PptPresentationMetrics,
    PptShapeBounds,
    PptSlideElement,
    PptSlideModel
} from '../../../utils/pptBinaryTypes';
import {
    inferSlideAspectKind,
    resolveThemeFontFamily
} from '../../../utils/pptSlideLayouts';

export interface RenderedSlideHandle {
    revoke(): void;
}

const TITLE_DEFAULT_FONT_PX = 36;
const BODY_DEFAULT_FONT_PX = 18;
// Default OOXML stroke width is 0.75pt (~1px @96dpi). The parser surfaces
// `<a:ln w="…">` as `borderWidthPx` (issue #75); the renderer falls back to
// this default whenever `borderWidthPx` is undefined.
const DEFAULT_STROKE_PX = 1;
const SVG_NS = 'http://www.w3.org/2000/svg';

export async function renderSlide(
    doc: PptxDocument,
    slide: PptxSlide,
    target: HTMLElement
): Promise<RenderedSlideHandle> {
    const blobUrls = new Set<string>();

    target.innerHTML = '';
    target.classList.add('pv-slide-host');
    target.style.position = 'relative';

    const frame = document.createElement('div');
    frame.className = 'pv-slide-frame';
    // Tag the frame with the inferred aspect-ratio bucket so CSS can apply
    // preset-specific tweaks (currently just a hook — the runtime size
    // still comes from the parsed widthPx / heightPx below).
    const aspectKind = inferSlideAspectKind({
        widthPx: slide.widthPx,
        heightPx: slide.heightPx
    });
    frame.dataset.aspect = aspectKind;
    frame.style.position = 'relative';
    frame.style.width = `${slide.widthPx}px`;
    frame.style.height = `${slide.heightPx}px`;
    frame.style.background = slide.backgroundColor || '#ffffff';
    frame.style.overflow = 'hidden';
    target.appendChild(frame);

    // Sort by zIndex ascending so later shapes paint on top.
    const ordered = [...slide.shapes].sort((a, b) => a.zIndex - b.zIndex);
    for (const shape of ordered) {
        const node = await renderShape(doc.zip, shape, blobUrls);
        if (node) frame.appendChild(node);
    }

    return {
        revoke(): void {
            blobUrls.forEach((url) => {
                try {
                    URL.revokeObjectURL(url);
                } catch {
                    // best-effort: revoke can throw if the URL is already gone.
                }
            });
            blobUrls.clear();
        }
    };
}

async function renderShape(
    zip: PptxZip,
    shape: PptxShape,
    blobUrls: Set<string>
): Promise<HTMLElement | null> {
    switch (shape.kind) {
        case 'text':
            return renderTextShape(shape);
        case 'picture':
            return await renderPictureShape(zip, shape, blobUrls);
        case 'placeholder':
            return renderPlaceholderShape(shape);
        case 'table':
            return renderTableShape(shape);
        case 'chart':
            return renderChartShape(shape);
        case 'diagram':
            return renderDiagramShape(shape);
        case 'shape':
            return renderGeometryShape(shape);
        default:
            return null;
    }
}

function applyShapePositioning(node: HTMLElement, shape: PptxShape): void {
    node.style.position = 'absolute';
    node.style.left = `${shape.x}px`;
    node.style.top = `${shape.y}px`;
    node.style.width = `${shape.width}px`;
    node.style.height = `${shape.height}px`;
    // Compose rotate + horizontal/vertical mirror into a single `transform`
    // string. Issue #75: `flipH` / `flipV` were previously parsed but never
    // surfaced on the rendered element. Mirroring is applied to all kinds so
    // text / picture / shape behave consistently.
    const transforms: string[] = [];
    if (shape.rotateDeg) transforms.push(`rotate(${shape.rotateDeg}deg)`);
    if (shape.flipH) transforms.push('scaleX(-1)');
    if (shape.flipV) transforms.push('scaleY(-1)');
    if (transforms.length > 0) {
        node.style.transform = transforms.join(' ');
        node.style.transformOrigin = 'center center';
    }
    node.style.boxSizing = 'border-box';
}

function renderTextShape(shape: PptxShape): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'pv-shape pv-shape-text';
    if (shape.isTitle) wrap.classList.add('pv-shape-title');
    applyShapePositioning(wrap, shape);

    // solidFill / gradFill — both fields are resolved by the parser via the
    // colour context. The renderer prefers `gradientFill` when both are set
    // because OOXML lets gradients carry an extra stop list that solidFill
    // alone cannot represent. noFill manifests as `fillColor === undefined`
    // *and* `gradientFill === undefined`, which leaves the element
    // transparent (no background style). Picture (blip) fills are still
    // deferred to a follow-up issue.
    applyFillToWrapper(wrap, shape);
    applyBorderToWrapper(wrap, shape);

    // Vertical alignment: prefer the explicit OOXML `anchor` when the
    // parser found one; otherwise fall back to the title=center /
    // body=top approximation matched in the VSCode reference.
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.justifyContent = resolveVerticalAlign(shape);
    wrap.style.padding = '4px 8px';
    wrap.style.overflow = 'hidden';
    // Theme-font fallback. Until the parser surfaces the `<a:latin
    // typeface=...>` token per-run, we pick the major font for titles and
    // the minor font for bodies — exactly how PowerPoint resolves
    // `+mj-lt` / `+mn-lt` when no override is present.
    wrap.style.fontFamily = resolveThemeFontFamily(undefined, { isTitle: !!shape.isTitle });

    const paragraphs = shape.paragraphs || [];
    for (const paragraph of paragraphs) {
        const p = renderParagraph(paragraph, !!shape.isTitle);
        wrap.appendChild(p);
    }

    return wrap;
}

function renderParagraph(paragraph: PptxParagraph, isTitle: boolean): HTMLElement {
    const p = document.createElement('div');
    p.className = 'pv-paragraph';
    p.style.margin = '0';
    p.style.padding = '0';

    if (paragraph.align === 'ctr') p.style.textAlign = 'center';
    else if (paragraph.align === 'r') p.style.textAlign = 'right';
    else if (paragraph.align === 'just') p.style.textAlign = 'justify';

    const indentLevel = Math.max(0, Math.min(8, paragraph.level || 0));
    if (indentLevel > 0) {
        p.style.marginLeft = `${indentLevel * 20}px`;
    }

    const baseSize = paragraph.fontSizePx
        || (isTitle ? TITLE_DEFAULT_FONT_PX : BODY_DEFAULT_FONT_PX);
    p.style.fontSize = `${baseSize}px`;
    p.style.lineHeight = '1.2';

    if (paragraph.bold) p.style.fontWeight = '700';
    if (paragraph.italic) p.style.fontStyle = 'italic';
    if (paragraph.color) p.style.color = paragraph.color;

    if (paragraph.bullet) {
        const bullet = document.createElement('span');
        bullet.textContent = '• ';
        bullet.className = 'pv-bullet';
        p.appendChild(bullet);
    }

    const runs = paragraph.runs && paragraph.runs.length > 0
        ? paragraph.runs
        : [{ text: paragraph.text } as PptxRun];

    for (const run of runs) {
        const span = document.createElement('span');
        span.textContent = run.text;
        if (run.fontSizePx) span.style.fontSize = `${run.fontSizePx}px`;
        if (run.bold !== undefined) {
            span.style.fontWeight = run.bold ? '700' : '400';
        }
        if (run.italic !== undefined) {
            span.style.fontStyle = run.italic ? 'italic' : 'normal';
        }
        if (run.color) span.style.color = run.color;
        p.appendChild(span);
    }

    return p;
}

async function renderPictureShape(
    zip: PptxZip,
    shape: PptxShape,
    blobUrls: Set<string>
): Promise<HTMLElement | null> {
    if (!shape.pictureTarget) return null;
    const file = zip.file(shape.pictureTarget);
    if (!file) {
        // Missing media — render an empty placeholder so the slot survives.
        return renderPlaceholderShape(shape);
    }
    let bytes: Uint8Array;
    try {
        bytes = await file.async('uint8array');
    } catch {
        return renderPlaceholderShape(shape);
    }

    let url: string;
    try {
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const blob = new Blob([ab], { type: shape.pictureMime || 'application/octet-stream' });
        url = URL.createObjectURL(blob);
        blobUrls.add(url);
    } catch {
        return renderPlaceholderShape(shape);
    }

    const wrap = document.createElement('div');
    wrap.className = 'pv-shape pv-shape-picture';
    applyShapePositioning(wrap, shape);

    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.style.display = 'block';

    const srcRect = shape.srcRect;
    if (srcRect && (srcRect.l || srcRect.t || srcRect.r || srcRect.b)) {
        // Apply <a:srcRect> crop. The OOXML edges are percentages of the
        // source image to hide; to expose only the visible window we
        // up-scale the <img> so the *visible* slice fills the wrapper, then
        // shift it left/up so the trimmed edges sit outside the wrapper.
        // The wrapper has `overflow: hidden` so the trimmed edges are
        // clipped. Math mirrors VSCode's createImageShape().
        const visibleW = Math.max(1, 100 - (srcRect.l || 0) - (srcRect.r || 0));
        const visibleH = Math.max(1, 100 - (srcRect.t || 0) - (srcRect.b || 0));
        const scaleW = 100 / visibleW;
        const scaleH = 100 / visibleH;
        img.style.position = 'absolute';
        img.style.width = `${100 * scaleW}%`;
        img.style.height = `${100 * scaleH}%`;
        img.style.left = `${-(srcRect.l || 0) * scaleW}%`;
        img.style.top = `${-(srcRect.t || 0) * scaleH}%`;
        img.style.objectFit = 'fill';
        img.style.maxWidth = 'none';
        img.style.maxHeight = 'none';
        wrap.style.overflow = 'hidden';
    } else {
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
    }

    wrap.appendChild(img);
    return wrap;
}

function renderPlaceholderShape(shape: PptxShape): HTMLElement | null {
    if (shape.width <= 0 || shape.height <= 0) return null;
    const wrap = document.createElement('div');
    wrap.className = 'pv-shape pv-shape-placeholder';
    applyShapePositioning(wrap, shape);
    applyFillToWrapper(wrap, shape);
    applyBorderToWrapper(wrap, shape);
    return wrap;
}

/**
 * Apply `gradientFill` (preferred) or `fillColor` to a non-SVG wrapper.
 * Issue #77: `gradientFill` becomes a CSS `linear-gradient(...)`; solid fills
 * stay as a flat `background` colour. When both are absent the wrapper is
 * left transparent (the `noFill` invariant from the parser).
 */
function applyFillToWrapper(wrap: HTMLElement, shape: PptxShape): void {
    if (shape.gradientFill && shape.gradientFill.stops.length > 0) {
        wrap.style.background = gradientFillToCss(shape.gradientFill);
        return;
    }
    if (shape.fillColor) {
        wrap.style.background = shape.fillColor;
    }
}

/**
 * Apply border colour / width / dash to a non-SVG wrapper. Honours
 * `borderWidthPx` (issue #75) and `borderDash` (issue #77) when set.
 */
function applyBorderToWrapper(wrap: HTMLElement, shape: PptxShape): void {
    if (!shape.borderColor) return;
    const width = (typeof shape.borderWidthPx === 'number' && shape.borderWidthPx > 0)
        ? shape.borderWidthPx
        : DEFAULT_STROKE_PX;
    const style = cssDashStyleFromPreset(shape.borderDash);
    wrap.style.border = `${width}px ${style} ${shape.borderColor}`;
}

/**
 * Serialize a parsed `gradientFill` as a CSS `linear-gradient(...)` string.
 * Stops are sorted by offset (the parser guarantees this) and each offset
 * is emitted as `<offset>%`. The angle is already normalised to CSS degrees
 * (0° = "to top", clockwise) by `extractGradientFill`.
 */
function gradientFillToCss(grad: NonNullable<PptxShape['gradientFill']>): string {
    const stopStr = grad.stops
        .map((s) => `${s.color} ${s.offset}%`)
        .join(', ');
    return `linear-gradient(${grad.angleDeg}deg, ${stopStr})`;
}

/**
 * Map an OOXML `<a:prstDash val>` value to a CSS `border-style` keyword.
 * CSS only supports a small vocabulary (`solid`, `dashed`, `dotted`) so the
 * preset names collapse into those buckets. Unknown / undefined returns
 * `'solid'`.
 */
function cssDashStyleFromPreset(preset: string | undefined): string {
    if (!preset) return 'solid';
    const p = preset.toLowerCase();
    if (p === 'dot' || p === 'sysdot') return 'dotted';
    if (p === 'solid') return 'solid';
    if (p.includes('dash') || p.includes('dot')) return 'dashed';
    return 'solid';
}

/**
 * Convert an OOXML `<a:prstDash val>` to an SVG `stroke-dasharray` value
 * (in stroke-width units). The numbers mirror PowerPoint's visual rendering
 * — short dashes / long dashes / dots / sysDash variants get distinct
 * patterns. Returns `null` when the preset is missing or maps to a solid
 * stroke (caller should skip emitting the attribute).
 */
function svgDashArrayFromPreset(preset: string | undefined): string | null {
    if (!preset) return null;
    const p = preset.toLowerCase();
    if (p === 'solid') return null;
    if (p === 'dot' || p === 'sysdot') return '1,3';
    if (p === 'dash' || p === 'sysdash') return '4,3';
    if (p === 'lgdash') return '8,3';
    if (p === 'dashdot' || p === 'sysdashdot') return '4,3,1,3';
    if (p === 'lgdashdot') return '8,3,1,3';
    if (p === 'lgdashdotdot' || p === 'sysdashdotdot') return '8,3,1,3,1,3';
    return '4,3';
}

/**
 * Resolve the CSS `justify-content` for vertical alignment based on the
 * explicit OOXML `anchor` attribute. Falls back to the title=center /
 * body=top approximation only when the parser did not surface an `anchor`.
 */
function resolveVerticalAlign(shape: PptxShape): string {
    const anchor = shape.anchor;
    if (anchor === 't') return 'flex-start';
    if (anchor === 'ctr') return 'center';
    if (anchor === 'b') return 'flex-end';
    return shape.isTitle ? 'center' : 'flex-start';
}

// ---------------------------------------------------------------------------
// Table / chart / SmartArt placeholders (issue #74)
// ---------------------------------------------------------------------------

function renderTableShape(shape: PptxShape): HTMLElement | null {
    if (shape.width <= 0 || shape.height <= 0) return null;
    const wrap = document.createElement('div');
    wrap.className = 'pv-shape pv-shape-table';
    applyShapePositioning(wrap, shape);
    wrap.style.overflow = 'hidden';
    wrap.style.background = '#ffffff';

    const table = document.createElement('table');
    table.className = 'pv-table';
    const rows = Array.isArray(shape.tableRows) ? shape.tableRows : [];
    rows.forEach((row, rowIndex) => {
        const tr = document.createElement('tr');
        row.forEach((cell) => {
            const td = document.createElement(rowIndex === 0 ? 'th' : 'td');
            td.textContent = cell || '';
            tr.appendChild(td);
        });
        table.appendChild(tr);
    });
    wrap.appendChild(table);
    return wrap;
}

function renderChartShape(shape: PptxShape): HTMLElement | null {
    if (shape.width <= 0 || shape.height <= 0) return null;
    const wrap = document.createElement('div');
    wrap.className = 'pv-shape pv-shape-chart';
    applyShapePositioning(wrap, shape);
    wrap.style.overflow = 'hidden';

    if (shape.chartData && (shape.chartData.kind === 'stackedColumn' || shape.chartData.kind === 'line')) {
        wrap.classList.add('pv-shape-chart-rendered');
        const canvas = document.createElement('canvas');
        // DPR-aware sizing: backing store is scaled for crisp text on
        // high-density displays, while the CSS box stays at the shape's
        // pixel geometry so the slide layout is unaffected.
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        const cssW = Math.max(120, Math.floor(shape.width));
        const cssH = Math.max(80, Math.floor(shape.height));
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        wrap.appendChild(canvas);

        if (shape.chartData.kind === 'stackedColumn') {
            drawStackedColumnChart(canvas, shape.chartData, dpr);
        } else {
            drawLineChart(canvas, shape.chartData, dpr);
        }
        return wrap;
    }

    // Placeholder branch: no chartData, or unsupported chart kind.
    wrap.classList.add('pv-shape-chart-placeholder');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = 'center';
    wrap.style.justifyContent = 'center';
    wrap.style.textAlign = 'center';
    wrap.style.background = '#f7f7f7';
    wrap.style.border = '1px dashed #9a9a9a';
    wrap.style.color = '#333333';

    const title = document.createElement('div');
    title.className = 'pv-chart-title';
    title.textContent = shape.chartTitle || 'Chart';
    title.style.fontSize = '14px';
    title.style.fontWeight = '700';
    title.style.marginBottom = '4px';
    wrap.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'pv-chart-subtitle';
    subtitle.textContent = 'Chart placeholder';
    subtitle.style.fontSize = '12px';
    subtitle.style.opacity = '0.8';
    wrap.appendChild(subtitle);

    return wrap;
}

function renderDiagramShape(shape: PptxShape): HTMLElement | null {
    if (shape.width <= 0 || shape.height <= 0) return null;
    const wrap = document.createElement('div');
    wrap.className = 'pv-shape pv-shape-diagram';
    applyShapePositioning(wrap, shape);
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = 'center';
    wrap.style.justifyContent = 'center';
    wrap.style.textAlign = 'center';
    wrap.style.background = '#f0f4fa';
    wrap.style.border = '1px dashed #6b86b3';
    wrap.style.color = '#1f3a66';
    wrap.style.overflow = 'hidden';

    const title = document.createElement('div');
    title.className = 'pv-chart-title';
    title.textContent = shape.chartTitle || 'SmartArt';
    title.style.fontSize = '14px';
    title.style.fontWeight = '700';
    title.style.marginBottom = '4px';
    wrap.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'pv-chart-subtitle';
    subtitle.textContent = 'SmartArt placeholder';
    subtitle.style.fontSize = '12px';
    subtitle.style.opacity = '0.8';
    wrap.appendChild(subtitle);

    return wrap;
}

// ---------------------------------------------------------------------------
// Shape rendering (issue #75): preset geometry / custGeom / line connector
// with arrow markers, fill / stroke from parser metadata.
// ---------------------------------------------------------------------------

/** Unique counter so marker `<id>` strings don't collide across shapes. */
let svgShapeCounter = 0;

/**
 * `<a:headEnd>` / `<a:tailEnd>` types that mean "no arrow marker." Anything
 * else (including unknown values) falls through to the default triangle.
 */
const NO_END_TYPES = new Set(['none', '']);

function renderGeometryShape(shape: PptxShape): HTMLElement | null {
    if (shape.width <= 0 || shape.height <= 0) return null;

    const wrap = document.createElement('div');
    wrap.className = 'pv-shape pv-shape-geometry';
    applyShapePositioning(wrap, shape);
    wrap.style.overflow = 'visible';

    const w = Math.max(1, Math.abs(shape.width));
    const h = Math.max(1, Math.abs(shape.height));
    const strokeWidth = resolveStrokeWidth(shape);
    const strokeColor = shape.borderColor; // undefined → noLine
    const dashArray = svgDashArrayFromPreset(shape.borderDash);

    const preset = shape.presetGeom;
    const isLine = preset === 'line' || preset === 'straightConnector1';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.style.display = 'block';
    svg.style.overflow = 'visible';
    svg.style.position = 'absolute';
    svg.style.left = '0';
    svg.style.top = '0';

    if (isLine) {
        renderLineConnector(svg, shape, w, h, strokeColor, strokeWidth, dashArray);
        wrap.appendChild(svg);
        return wrap;
    }

    // Path-based shape (custom geometry takes priority; otherwise the preset
    // table). Fallback to a rectangle so unknown presets still render.
    const resolvedPath = shape.customSvgPath
        || (preset ? presetGeomToSvgPath(preset, w, h) : null)
        || `M0 0 L${w} 0 L${w} ${h} L0 ${h} Z`;

    // Resolve the fill: gradient takes precedence (when present we emit a
    // <linearGradient> def and reference it as `url(#...)`); otherwise the
    // solid `fillColor` becomes a direct `fill` attribute. `noFill` falls
    // through to `'none'` so the path renders only its stroke.
    const fillValue = (() => {
        if (shape.gradientFill && shape.gradientFill.stops.length > 0) {
            const id = `pv-grad-${++svgShapeCounter}`;
            const defs = document.createElementNS(SVG_NS, 'defs');
            defs.appendChild(buildLinearGradientDef(id, shape.gradientFill));
            svg.appendChild(defs);
            return `url(#${id})`;
        }
        return shape.fillColor || 'none';
    })();

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', resolvedPath);
    path.setAttribute('fill', fillValue);
    if (strokeColor) {
        path.setAttribute('stroke', strokeColor);
        path.setAttribute('stroke-width', String(strokeWidth));
        if (dashArray) path.setAttribute('stroke-dasharray', dashArray);
    } else {
        path.setAttribute('stroke', 'none');
    }
    svg.appendChild(path);
    wrap.appendChild(svg);
    return wrap;
}

/**
 * Build an `<svg:linearGradient>` element from a parsed `gradientFill`.
 * The gradient angle is converted from CSS degrees (0° = "to top") into
 * SVG `x1/y1` / `x2/y2` end-points on a unit square so it composes with the
 * shape's `viewBox`. Stops are emitted in offset order.
 */
function buildLinearGradientDef(id: string, grad: NonNullable<PptxShape['gradientFill']>): SVGLinearGradientElement {
    const def = document.createElementNS(SVG_NS, 'linearGradient');
    def.setAttribute('id', id);
    def.setAttribute('gradientUnits', 'objectBoundingBox');

    // CSS angle 0° = bottom-to-top; SVG default is left-to-right. Convert
    // the CSS angle into x1/y1/x2/y2 on the unit square. Math: in CSS terms,
    // the gradient vector points *to* angleDeg measured clockwise from north.
    const rad = (grad.angleDeg - 90) * (Math.PI / 180);
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const x1 = 0.5 - dx / 2;
    const y1 = 0.5 - dy / 2;
    const x2 = 0.5 + dx / 2;
    const y2 = 0.5 + dy / 2;
    def.setAttribute('x1', x1.toFixed(4));
    def.setAttribute('y1', y1.toFixed(4));
    def.setAttribute('x2', x2.toFixed(4));
    def.setAttribute('y2', y2.toFixed(4));

    for (const stop of grad.stops) {
        const node = document.createElementNS(SVG_NS, 'stop');
        node.setAttribute('offset', `${stop.offset}%`);
        node.setAttribute('stop-color', stop.color);
        def.appendChild(node);
    }
    return def;
}

function resolveStrokeWidth(shape: PptxShape): number {
    if (typeof shape.borderWidthPx === 'number' && Number.isFinite(shape.borderWidthPx) && shape.borderWidthPx > 0) {
        return shape.borderWidthPx;
    }
    return DEFAULT_STROKE_PX;
}

function renderLineConnector(
    svg: SVGSVGElement,
    shape: PptxShape,
    w: number,
    h: number,
    strokeColor: string | undefined,
    strokeWidth: number,
    dashArray: string | null
): void {
    const color = strokeColor || '#000000';
    const id = ++svgShapeCounter;

    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.appendChild(buildArrowMarker(`pv-arrow-${id}`, color));
    defs.appendChild(buildTriangleMarker(`pv-triangle-${id}`, color));
    defs.appendChild(buildStealthMarker(`pv-stealth-${id}`, color));
    defs.appendChild(buildDiamondMarker(`pv-diamond-${id}`, color));
    defs.appendChild(buildOvalMarker(`pv-oval-${id}`, color));
    svg.appendChild(defs);

    const line = document.createElementNS(SVG_NS, 'line');
    // flipH/flipV reverse the line direction within its bounding box; matches
    // the VSCode reference. The outer wrapper does not apply scale(-1) for
    // connector shapes because the SVG already encodes the orientation.
    const fH = !!shape.flipH;
    const fV = !!shape.flipV;
    line.setAttribute('x1', String(fH ? w : 0));
    line.setAttribute('y1', String(fV ? h : 0));
    line.setAttribute('x2', String(fH ? 0 : w));
    line.setAttribute('y2', String(fV ? 0 : h));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(strokeWidth));
    if (dashArray) line.setAttribute('stroke-dasharray', dashArray);
    if (!strokeColor) {
        // noLine connector: render an invisible line so the box still anchors
        // but produces no visible stroke. Matches "respect noLine".
        line.setAttribute('stroke', 'none');
    }

    const headUrl = markerUrlForType(shape.headEnd, id);
    const tailUrl = markerUrlForType(shape.tailEnd, id);
    if (headUrl) line.setAttribute('marker-start', headUrl);
    if (tailUrl) line.setAttribute('marker-end', tailUrl);

    svg.appendChild(line);
}

function markerUrlForType(type: string | undefined, id: number): string | null {
    if (!type || NO_END_TYPES.has(type)) return null;
    switch (type) {
        case 'arrow':
            return `url(#pv-arrow-${id})`;
        case 'triangle':
            return `url(#pv-triangle-${id})`;
        case 'stealth':
            return `url(#pv-stealth-${id})`;
        case 'diamond':
            return `url(#pv-diamond-${id})`;
        case 'oval':
            return `url(#pv-oval-${id})`;
        default:
            return `url(#pv-triangle-${id})`;
    }
}

function buildArrowMarker(id: string, color: string): SVGMarkerElement {
    const m = document.createElementNS(SVG_NS, 'marker');
    m.setAttribute('id', id);
    m.setAttribute('markerWidth', '10');
    m.setAttribute('markerHeight', '8');
    m.setAttribute('refX', '9');
    m.setAttribute('refY', '4');
    m.setAttribute('orient', 'auto');
    m.setAttribute('markerUnits', 'strokeWidth');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M0 0 L10 4 L0 8');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '1.2');
    m.appendChild(path);
    return m;
}

function buildTriangleMarker(id: string, color: string): SVGMarkerElement {
    const m = document.createElementNS(SVG_NS, 'marker');
    m.setAttribute('id', id);
    m.setAttribute('markerWidth', '8');
    m.setAttribute('markerHeight', '6');
    m.setAttribute('refX', '8');
    m.setAttribute('refY', '3');
    m.setAttribute('orient', 'auto');
    m.setAttribute('markerUnits', 'strokeWidth');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M0 0 L8 3 L0 6 Z');
    path.setAttribute('fill', color);
    m.appendChild(path);
    return m;
}

function buildStealthMarker(id: string, color: string): SVGMarkerElement {
    const m = document.createElementNS(SVG_NS, 'marker');
    m.setAttribute('id', id);
    m.setAttribute('markerWidth', '10');
    m.setAttribute('markerHeight', '7');
    m.setAttribute('refX', '10');
    m.setAttribute('refY', '3.5');
    m.setAttribute('orient', 'auto');
    m.setAttribute('markerUnits', 'strokeWidth');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M0 0 L10 3.5 L0 7 L3 3.5 Z');
    path.setAttribute('fill', color);
    m.appendChild(path);
    return m;
}

function buildDiamondMarker(id: string, color: string): SVGMarkerElement {
    const m = document.createElementNS(SVG_NS, 'marker');
    m.setAttribute('id', id);
    m.setAttribute('markerWidth', '8');
    m.setAttribute('markerHeight', '8');
    m.setAttribute('refX', '4');
    m.setAttribute('refY', '4');
    m.setAttribute('orient', 'auto');
    m.setAttribute('markerUnits', 'strokeWidth');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M4 0 L8 4 L4 8 L0 4 Z');
    path.setAttribute('fill', color);
    m.appendChild(path);
    return m;
}

function buildOvalMarker(id: string, color: string): SVGMarkerElement {
    const m = document.createElementNS(SVG_NS, 'marker');
    m.setAttribute('id', id);
    m.setAttribute('markerWidth', '6');
    m.setAttribute('markerHeight', '6');
    m.setAttribute('refX', '3');
    m.setAttribute('refY', '3');
    m.setAttribute('orient', 'auto');
    m.setAttribute('markerUnits', 'strokeWidth');
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', '3');
    circle.setAttribute('cy', '3');
    circle.setAttribute('r', '2.5');
    circle.setAttribute('fill', color);
    m.appendChild(circle);
    return m;
}

/**
 * Map an OOXML `<a:prstGeom prst="…">` name to an SVG path `d` string sized
 * to `w` x `h` (in CSS px). Ported from the VSCode reference; presets without
 * a clean mapping return `null` so the caller can render a default rectangle
 * fallback. Supported presets: rect, ellipse / oval, roundRect, triangle,
 * rtTriangle, diamond, parallelogram, trapezoid, leftArrow, rightArrow,
 * upArrow, downArrow, line, straightConnector1.
 */
export function presetGeomToSvgPath(preset: string, w: number, h: number): string | null {
    if (!w || w < 0 || !h || h < 0) return null;
    switch (preset) {
        case 'rect':
            return `M0 0 L${w} 0 L${w} ${h} L0 ${h} Z`;
        case 'ellipse':
        case 'oval':
            return `M ${w / 2} 0 A ${w / 2} ${h / 2} 0 1 0 ${w / 2} ${h} A ${w / 2} ${h / 2} 0 1 0 ${w / 2} 0 Z`;
        case 'roundRect': {
            const r = Math.min(w, h) * 0.12;
            return `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z`;
        }
        case 'triangle':
            return `M ${w / 2} 0 L ${w} ${h} L 0 ${h} Z`;
        case 'rtTriangle':
            return `M 0 0 L 0 ${h} L ${w} ${h} Z`;
        case 'diamond':
            return `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;
        case 'parallelogram': {
            const slant = Math.min(w * 0.25, h * 0.5);
            return `M ${slant} 0 L ${w} 0 L ${w - slant} ${h} L 0 ${h} Z`;
        }
        case 'trapezoid': {
            const inset = Math.min(w * 0.25, h * 0.5);
            return `M ${inset} 0 L ${w - inset} 0 L ${w} ${h} L 0 ${h} Z`;
        }
        case 'rightArrow': {
            const bodyH = h * 0.6;
            const bodyTop = (h - bodyH) / 2;
            const headW = Math.min(w * 0.35, h * 0.9);
            const bodyRight = w - headW;
            return `M 0 ${bodyTop} L ${bodyRight} ${bodyTop} L ${bodyRight} 0 L ${w} ${h / 2} L ${bodyRight} ${h} L ${bodyRight} ${bodyTop + bodyH} L 0 ${bodyTop + bodyH} Z`;
        }
        case 'leftArrow': {
            const bodyH = h * 0.6;
            const bodyTop = (h - bodyH) / 2;
            const headW = Math.min(w * 0.35, h * 0.9);
            return `M ${w} ${bodyTop} L ${headW} ${bodyTop} L ${headW} 0 L 0 ${h / 2} L ${headW} ${h} L ${headW} ${bodyTop + bodyH} L ${w} ${bodyTop + bodyH} Z`;
        }
        case 'upArrow': {
            const bodyW = w * 0.6;
            const bodyLeft = (w - bodyW) / 2;
            const headH = Math.min(h * 0.35, w * 0.9);
            return `M ${bodyLeft} ${h} L ${bodyLeft} ${headH} L 0 ${headH} L ${w / 2} 0 L ${w} ${headH} L ${bodyLeft + bodyW} ${headH} L ${bodyLeft + bodyW} ${h} Z`;
        }
        case 'downArrow': {
            const bodyW = w * 0.6;
            const bodyLeft = (w - bodyW) / 2;
            const headH = Math.min(h * 0.35, w * 0.9);
            const bodyBottom = h - headH;
            return `M ${bodyLeft} 0 L ${bodyLeft + bodyW} 0 L ${bodyLeft + bodyW} ${bodyBottom} L ${w} ${bodyBottom} L ${w / 2} ${h} L 0 ${bodyBottom} L ${bodyLeft} ${bodyBottom} Z`;
        }
        case 'line':
        case 'straightConnector1':
            return `M 0 0 L ${w} ${h}`;
        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// Canvas 2D chart drawing (ported from vscode-omni-viewer pptViewer.js,
// simplified — Chrome carries `categories` + `series[].values` only, so the
// axis tick / data-label / legend styling that the VSCode renderer reads
// from `chartData.valueAxis` / `chartData.legend` falls back to defaults.)
// ---------------------------------------------------------------------------

interface MinimalChartData {
    kind: 'stackedColumn' | 'line';
    categories: string[];
    series: { name?: string; values: number[] }[];
}

function getNiceStep(span: number, targetTicks: number): number {
    const safeSpan = Math.max(0.000001, span);
    const rough = safeSpan / Math.max(1, targetTicks);
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const normalized = rough / power;
    let unit = 1;
    if (normalized > 5) unit = 10;
    else if (normalized > 2) unit = 5;
    else if (normalized > 1) unit = 2;
    return unit * power;
}

function formatChartValue(value: number): string {
    // Simplified vs VSCode: no `formatCode` parsing — the Chrome
    // PptxChartData type intentionally omits per-series numeric formats.
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function drawStackedColumnChart(canvas: HTMLCanvasElement, chartData: MinimalChartData, dpr: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Scale the drawing context so the rest of the code can think in CSS px.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const margin = { left: 56, right: 16, top: 16, bottom: 64 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;
    if (plotW <= 20 || plotH <= 20) return;

    const categories = chartData.categories || [];
    const series = chartData.series || [];
    if (categories.length === 0 || series.length === 0) return;

    const palette = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];

    // Stacked sums per category (positive + negative bases).
    const sums = categories.map((_, idx) =>
        series.reduce((acc, s) => acc + Math.max(0, Number(s.values[idx] || 0)), 0)
    );
    const mins = categories.map((_, idx) =>
        series.reduce((acc, s) => acc + Math.min(0, Number(s.values[idx] || 0)), 0)
    );
    const minValue = Math.min(0, ...mins);
    let maxValue = Math.max(1, ...sums);
    if (minValue >= maxValue) maxValue = minValue + 1;
    const span = maxValue - minValue;
    const yFor = (v: number): number => margin.top + ((maxValue - v) / span) * plotH;
    const yStep = getNiceStep(span, 6);

    ctx.clearRect(0, 0, w, h);

    // Frame + horizontal gridlines + y-axis tick labels.
    ctx.strokeStyle = '#bfbfbf';
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, plotW, plotH);

    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.font = '400 11px Arial, sans-serif';
    ctx.fillStyle = '#222222';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let tick = Math.floor(minValue / yStep) * yStep;
    let safety = 0;
    while (tick <= maxValue + yStep * 0.5 && safety < 200) {
        const y = yFor(tick);
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(margin.left + plotW, y);
        ctx.stroke();
        ctx.fillText(formatChartValue(tick), margin.left - 6, y);
        tick += yStep;
        safety += 1;
    }

    // Zero baseline.
    const zeroY = yFor(0);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(margin.left, zeroY);
    ctx.lineTo(margin.left + plotW, zeroY);
    ctx.stroke();

    // Bars + category labels.
    const groupW = plotW / categories.length;
    const barW = Math.max(6, groupW * 0.58);
    categories.forEach((cat, idx) => {
        const cx = margin.left + groupW * idx + groupW / 2;
        let posBase = 0;
        let negBase = 0;
        series.forEach((s, sIdx) => {
            const raw = Number(s.values[idx] || 0);
            if (!Number.isFinite(raw) || raw === 0) return;
            let from: number;
            let to: number;
            if (raw >= 0) {
                from = yFor(posBase);
                posBase += raw;
                to = yFor(posBase);
            } else {
                from = yFor(negBase);
                negBase += raw;
                to = yFor(negBase);
            }
            const top = Math.min(from, to);
            const height = Math.max(1, Math.abs(from - to));
            ctx.fillStyle = palette[sIdx % palette.length];
            ctx.fillRect(cx - barW / 2, top, barW, height);
        });

        ctx.fillStyle = '#222222';
        ctx.font = '400 11px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(String(cat), cx, h - margin.bottom + 16);
    });

    drawLegend(ctx, w, h, series, palette, 'swatch');
}

function drawLineChart(canvas: HTMLCanvasElement, chartData: MinimalChartData, dpr: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const margin = { left: 56, right: 16, top: 16, bottom: 64 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;
    if (plotW <= 20 || plotH <= 20) return;

    const categories = chartData.categories || [];
    const series = chartData.series || [];
    if (categories.length === 0 || series.length === 0) return;

    const palette = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];

    const numericValues = series.flatMap((s) => s.values || []).filter((v) => Number.isFinite(v));
    if (numericValues.length === 0) return;

    let minValue = Math.min(0, ...numericValues);
    let maxValue = Math.max(...numericValues);
    if (minValue >= maxValue) {
        const pad = Math.max(1, Math.abs(maxValue || 1) * 0.1);
        minValue -= pad;
        maxValue += pad;
    }
    const span = maxValue - minValue;
    const yFor = (v: number): number => margin.top + ((maxValue - v) / span) * plotH;
    const yStep = getNiceStep(span, 6);
    const xForIndex = (idx: number): number => (
        categories.length === 1
            ? margin.left + plotW / 2
            : margin.left + (plotW / Math.max(1, categories.length - 1)) * idx
    );

    ctx.clearRect(0, 0, w, h);

    // Gridlines + axis tick labels.
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.font = '400 11px Arial, sans-serif';
    ctx.fillStyle = '#222222';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let tick = Math.floor(minValue / yStep) * yStep;
    let safety = 0;
    while (tick <= maxValue + yStep * 0.5 && safety < 200) {
        const y = yFor(tick);
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(margin.left + plotW, y);
        ctx.stroke();
        ctx.fillText(formatChartValue(tick), margin.left - 6, y);
        tick += yStep;
        safety += 1;
    }

    // Axes frame.
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top + plotH);
    ctx.stroke();

    // Category labels.
    categories.forEach((cat, idx) => {
        const x = xForIndex(idx);
        ctx.fillStyle = '#222222';
        ctx.font = '400 11px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(String(cat), x, h - margin.bottom + 16);
    });

    // Series lines + markers.
    series.forEach((s, sIdx) => {
        const values = s.values || [];
        const color = palette[sIdx % palette.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        values.forEach((raw, idx) => {
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            const x = xForIndex(idx);
            const y = yFor(n);
            if (!started) {
                ctx.moveTo(x, y);
                started = true;
            } else {
                ctx.lineTo(x, y);
            }
        });
        if (started) ctx.stroke();

        values.forEach((raw, idx) => {
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            const x = xForIndex(idx);
            const y = yFor(n);
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(x, y, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, y, 3.5, 0, Math.PI * 2);
            ctx.stroke();
        });
    });

    drawLegend(ctx, w, h, series, palette, 'line');
}

function drawLegend(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    series: { name?: string }[],
    palette: string[],
    marker: 'swatch' | 'line'
): void {
    const legendFontSize = 12;
    const items = series.map((s, i) => ({
        color: palette[i % palette.length],
        label: s.name || `Series ${i + 1}`
    }));
    const swatchW = marker === 'swatch' ? 10 : 16;
    const itemGap = 18;
    const contentWidth = items.reduce(
        (acc, item) => acc + swatchW + 6 + item.label.length * (legendFontSize * 0.55) + itemGap,
        0
    );
    let cursorX = Math.max(8, (w - contentWidth) / 2);
    const legendY = h - 8;

    ctx.font = `400 ${legendFontSize}px Arial, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    items.forEach((item) => {
        if (marker === 'swatch') {
            ctx.fillStyle = item.color;
            ctx.fillRect(cursorX, legendY - 10, swatchW, swatchW);
        } else {
            ctx.strokeStyle = item.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cursorX, legendY - 5);
            ctx.lineTo(cursorX + swatchW, legendY - 5);
            ctx.stroke();
        }
        cursorX += swatchW + 6;
        ctx.fillStyle = '#222222';
        ctx.fillText(item.label, cursorX, legendY - 1);
        cursorX += item.label.length * (legendFontSize * 0.55) + itemGap;
    });
}

// ---------------------------------------------------------------------------
// Legacy `.ppt` (PowerPoint 97-2003) full-model renderer (issue #78)
//
// When the binary parser surfaces `PptSlideModel.elements` (shape-attributed
// text + picture references in raw legacy coordinates), the viewer paints
// each element into an absolutely-positioned `<div>` / `<img>` instead of
// the flat text-only block. Coordinates are normalised from raw master
// units (or EMU) to slide pixels using `PptPresentationMetrics.rawWidth /
// rawHeight`.
//
// Out of scope for issue #78 (text + pictures only):
//   - Master / layout decorative elements.
//   - Colour scheme resolution beyond the slide background and per-run styling.
//   - Decorative shape rendering (rectangles, callouts, connectors).
//   - Bullet glyph rendering for legacy bullet markers.
//   - EMF / WMF BLIPs.
// ---------------------------------------------------------------------------

export interface LegacyRenderInput {
    slide: PptSlideModel;
    metrics: PptPresentationMetrics;
}

const LEGACY_TITLE_FONT_PX = 32;
const LEGACY_BODY_FONT_PX = 18;
const LEGACY_TEXT_PADDING_PX = 8;

function normalizeLegacyBounds(
    bounds: PptShapeBounds | undefined,
    metrics: PptPresentationMetrics
): PptShapeBounds | undefined {
    if (!bounds) return undefined;
    if (metrics.rawWidth <= 0 || metrics.rawHeight <= 0) return undefined;
    const scaleX = metrics.widthPx / metrics.rawWidth;
    const scaleY = metrics.heightPx / metrics.rawHeight;
    const x = Math.max(0, Math.round(bounds.x * scaleX));
    const y = Math.max(0, Math.round(bounds.y * scaleY));
    const width = Math.max(8, Math.round(bounds.width * scaleX));
    const height = Math.max(8, Math.round(bounds.height * scaleY));
    return {
        x: Math.min(metrics.widthPx - 8, x),
        y: Math.min(metrics.heightPx - 8, y),
        width: Math.min(metrics.widthPx - x, width),
        height: Math.min(metrics.heightPx - y, height)
    };
}

function pickPictureAsset(
    pictureId: number,
    pictures: PptPictureAsset[] | undefined
): PptPictureAsset | undefined {
    if (!pictures) return undefined;
    for (const asset of pictures) {
        if (asset.id === pictureId) return asset;
    }
    return undefined;
}

function renderLegacyTextElement(
    element: Extract<PptSlideElement, { kind: 'text' }>,
    metrics: PptPresentationMetrics
): HTMLElement {
    const node = document.createElement('div');
    node.className = 'pv-legacy-shape pv-legacy-text';
    node.style.position = 'absolute';
    node.style.boxSizing = 'border-box';
    node.style.padding = `${LEGACY_TEXT_PADDING_PX}px`;
    node.style.whiteSpace = 'pre-wrap';
    node.style.wordBreak = 'break-word';
    node.style.color = '#000000';
    node.style.lineHeight = '1.4';
    node.style.overflow = 'hidden';
    node.textContent = element.text;

    const bounds = normalizeLegacyBounds(element.bounds, metrics);
    if (bounds) {
        node.style.left = `${bounds.x}px`;
        node.style.top = `${bounds.y}px`;
        node.style.width = `${bounds.width}px`;
        node.style.height = `${bounds.height}px`;
    } else {
        // Orphaned text: stretch across the slide horizontally and let
        // the renderer stack them vertically with a flow position.
        node.style.left = '24px';
        node.style.right = '24px';
        node.style.position = 'relative';
        node.style.marginBottom = '8px';
    }

    if (element.placeholderKind === 'title') {
        node.classList.add('pv-legacy-title');
        node.style.fontSize = `${LEGACY_TITLE_FONT_PX}px`;
        node.style.fontWeight = '600';
    } else {
        node.style.fontSize = `${LEGACY_BODY_FONT_PX}px`;
    }
    return node;
}

function renderLegacyPictureElement(
    element: Extract<PptSlideElement, { kind: 'picture' }>,
    pictures: PptPictureAsset[] | undefined,
    metrics: PptPresentationMetrics,
    blobUrls: Set<string>
): HTMLElement | null {
    const asset = pickPictureAsset(element.pictureId, pictures);
    if (!asset) return null;
    const blob = new Blob([asset.bytes], { type: asset.mime });
    const url = URL.createObjectURL(blob);
    blobUrls.add(url);

    const img = document.createElement('img');
    img.className = 'pv-legacy-shape pv-legacy-picture';
    img.alt = '';
    img.src = url;
    img.style.position = 'absolute';
    img.style.boxSizing = 'border-box';
    img.style.objectFit = 'contain';

    const bounds = normalizeLegacyBounds(element.bounds, metrics);
    if (bounds) {
        img.style.left = `${bounds.x}px`;
        img.style.top = `${bounds.y}px`;
        img.style.width = `${bounds.width}px`;
        img.style.height = `${bounds.height}px`;
    } else {
        // Picture without bounds — paint at slide origin at a default
        // size. This is rare (every shape with a BLIP ref has anchors
        // in practice) but keeps the renderer defensive.
        img.style.left = '24px';
        img.style.top = '24px';
        img.style.width = `${Math.min(360, metrics.widthPx - 48)}px`;
        img.style.height = `${Math.min(270, metrics.heightPx - 48)}px`;
    }
    return img;
}

/**
 * Render a legacy `.ppt` slide using the full `PptSlideModel.elements`
 * model. Returns a `RenderedSlideHandle` whose `revoke` releases every
 * picture blob URL created during the render — matching the .pptx path.
 */
export function renderLegacyPptSlide(
    input: LegacyRenderInput,
    target: HTMLElement
): RenderedSlideHandle {
    const { slide, metrics } = input;
    const blobUrls = new Set<string>();

    target.innerHTML = '';
    target.classList.add('pv-slide-host');
    target.style.position = 'relative';

    const frame = document.createElement('div');
    frame.className = 'pv-slide-frame slide-frame';
    frame.style.position = 'relative';
    frame.style.width = `${metrics.widthPx}px`;
    frame.style.height = `${metrics.heightPx}px`;
    frame.style.background = slide.backgroundColor || '#ffffff';
    frame.style.overflow = 'hidden';
    target.appendChild(frame);

    // If the parser produced no elements (text-only fallback path), emit
    // the joined text as a single block so the viewer still shows
    // *something*. The viewer's legacy dispatch checks for `elements`
    // first and only enters this renderer when it's populated, but we
    // keep the guard so direct callers (tests) behave sanely.
    const elements = slide.elements;
    if (!elements || elements.length === 0) {
        const fallback = document.createElement('div');
        fallback.className = 'slide-text pv-slide-text';
        fallback.style.padding = '32px 48px';
        fallback.style.fontSize = '18px';
        fallback.style.lineHeight = '1.5';
        fallback.style.whiteSpace = 'pre-wrap';
        fallback.style.wordBreak = 'break-word';
        fallback.textContent = slide.texts.join('\n\n');
        frame.appendChild(fallback);
        return { revoke: () => undefined };
    }

    for (const element of elements) {
        if (element.kind === 'text') {
            const node = renderLegacyTextElement(element, metrics);
            frame.appendChild(node);
        } else if (element.kind === 'picture') {
            const node = renderLegacyPictureElement(element, slide.pictures, metrics, blobUrls);
            if (node) frame.appendChild(node);
        }
    }

    return {
        revoke(): void {
            blobUrls.forEach((url) => {
                try {
                    URL.revokeObjectURL(url);
                } catch {
                    // best-effort: revoke can throw if already gone.
                }
            });
            blobUrls.clear();
        }
    };
}
