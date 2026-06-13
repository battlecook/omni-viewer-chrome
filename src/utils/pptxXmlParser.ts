/**
 * Browser-side PPTX XML parser (issue #46 — pragmatic port from VSCode
 * `vscode-omni-viewer/src/utils/pptxXmlParser.ts`).
 *
 * The VSCode original is ~72 KB and covers charts, tables, custGeom paths,
 * theme colour transforms, gradient fills, etc. The Chrome port intentionally
 * scopes back to the DoD of the parent issue:
 *
 *   - parse `ppt/slides/slide*.xml` plus the layout / master / theme parts,
 *   - extract a tree of `Slide` objects with `shapes[]` (each having
 *     position + size + content kind: `text | picture | placeholder`),
 *   - support placeholder inheritance for the title-vs-body branch only,
 *   - support text runs / paragraphs (level + bullet + run-level styling
 *     when present so the renderer can show real fonts / colours / sizes),
 *   - resolve `<a:blip r:embed="...">` to a `ppt/media/...` zip entry so
 *     callers can later turn the bytes into a `URL.createObjectURL(blob)`.
 *
 * Deferred (see issue #46 follow-ups #47 / #48):
 *   - picture (blipFill) fills on non-`p:pic` shapes,
 *   - radial / path gradients with `<a:tileRect>` or `<a:path>`,
 *   - per-paragraph indent / spacing beyond what extractTextParagraphs reads,
 *   - theme major/minor font resolution for text runs,
 *   - master-layout cascade for placeholders other than title/body
 *     (date / footer / slide-number prompt text is still suppressed; other
 *     placeholder types fall through without explicit inheritance).
 *
 * Design notes:
 *
 *   - The parser is browser-only. `JSZip` is loaded lazily from
 *     `vendor/jszip.min.js` by the viewer entry; this file does not touch
 *     `chrome.runtime` directly — it just accepts a duck-typed `PptxZip`
 *     that mimics the JSZip subset we need (`file(name)` returning an
 *     async-readable record, plus `files` for enumeration). That makes
 *     the parser unit-testable without bundling JSZip into the test
 *     environment.
 *
 *   - XML parsing uses regex-driven tag extraction (matching the VSCode
 *     original) instead of `DOMParser.parseFromString(..., 'application/xml')`.
 *     The reasons match the VSCode reasoning:
 *       * the `a:` / `p:` / `r:` prefixes used in PPTX XML do not survive
 *         a round-trip through jsdom's namespaced parser as cleanly as
 *         the OOXML files require, and
 *       * regex extraction avoids surfacing a "parser error" element when
 *         a slide contains slightly malformed Office output (trailing
 *         whitespace inside attribute values, missing closing tags inside
 *         skip-able blocks, etc.).
 *     The trade-off is that the helpers below are intentionally narrow
 *     and well-tested — they are *not* a general-purpose XML parser.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PptxRun {
    text: string;
    fontSizePx?: number;
    bold?: boolean;
    italic?: boolean;
    color?: string;
}

export interface PptxParagraph {
    text: string;
    level: number;
    bullet?: boolean;
    align?: string;
    fontSizePx?: number;
    bold?: boolean;
    italic?: boolean;
    color?: string;
    runs?: PptxRun[];
}

/**
 * A single laid-out item on a slide. The `kind` discriminator mirrors the
 * pragmatic-scope branches called out in issue #46, extended by issues #74
 * and #75:
 *
 *   - `text`        — text-bearing shape (placeholder or freestanding).
 *   - `picture`     — image embedded via `<a:blip r:embed="...">`.
 *   - `placeholder` — geometry-only placeholder used when a master/layout
 *                     placeholder is inherited but the slide has no override.
 *                     The renderer treats this as a no-op slot.
 *   - `table`       — OOXML table inside a `<p:graphicFrame>` whose
 *                     `<a:graphicData uri>` ends in `/relationships/table`.
 *   - `chart`       — OOXML chart inside a `<p:graphicFrame>` whose
 *                     `<a:graphicData uri>` ends in `/relationships/chart`.
 *                     `chartData` is populated when the chart kind is
 *                     supported (currently `stackedColumn` / `line`);
 *                     unsupported kinds fall back to title-only.
 *   - `diagram`     — SmartArt placeholder (graphicData URI ends in
 *                     `/relationships/diagram`). The parser does not attempt
 *                     to reconstruct the SmartArt layout — only geometry and
 *                     an optional title survive.
 *   - `shape`       — preset / custom geometry or line connector shape
 *                     (issue #75). Carries `presetGeom`, `customSvgPath`,
 *                     `headEnd`, `tailEnd`, `flipH`, `flipV`,
 *                     `borderWidthPx`, plus the standard fill/border
 *                     colour fields. The renderer paints an inline SVG.
 */
export type PptxShapeKind = 'text' | 'picture' | 'placeholder' | 'table' | 'chart' | 'diagram' | 'shape';

/**
 * Minimum-viable chart payload sourced from `ppt/charts/chart*.xml`. The
 * renderer draws this with Canvas 2D; extending the shape (e.g. axis tick
 * styling, secondary axes) is allowed when the renderer needs it.
 */
export interface PptxChartData {
    kind: 'stackedColumn' | 'line';
    categories: string[];
    series: { name?: string; values: number[] }[];
}

/**
 * Parsed `<a:gradFill>` payload (issue #77). Surfaces just the data the
 * renderer needs to emit a CSS `linear-gradient(...)` for HTML wrappers or an
 * `<svg:linearGradient>` for path-based shapes.
 *
 *   - `angleDeg`   — OOXML `<a:lin ang="…">` value normalised to CSS degrees
 *                    (0° = "to top", clockwise). When the gradient lacks
 *                    `<a:lin>` (radial / path gradients), this is 0 and the
 *                    renderer treats it as a default top-to-bottom fill.
 *   - `stops`      — at least two stops; each `offset` is 0-100 (matching
 *                    `<a:gs pos>` after normalisation), `color` is a resolved
 *                    `#rrggbb` hex with all colour transforms applied. When the
 *                    source had only one stop, it is duplicated so consumers
 *                    can always assume a valid pair.
 */
export interface PptxGradientFill {
    angleDeg: number;
    stops: { offset: number; color: string }[];
}

export interface PptxShape {
    kind: PptxShapeKind;
    x: number;
    y: number;
    width: number;
    height: number;
    rotateDeg?: number;
    zIndex: number;
    sourcePriority: number;
    placeholderKey?: string;
    isTitle?: boolean;
    paragraphs?: PptxParagraph[];
    /**
     * Resolved zip path of the embedded image (e.g. `ppt/media/image1.png`).
     * The renderer is responsible for turning this into a `Blob` /
     * `URL.createObjectURL` — the parser does not own that lifecycle so the
     * caller can cache / revoke as appropriate.
     */
    pictureTarget?: string;
    pictureMime?: string;
    /**
     * OOXML `<a:srcRect l="" t="" r="" b=""/>` crop, normalised to percentages
     * in the range [0, 100]. Each value is the distance (as a percent of the
     * source image) from the corresponding edge to crop away. `undefined`
     * when the source has no `<a:srcRect>` or all four values are zero.
     */
    srcRect?: { l: number; t: number; r: number; b: number };
    /**
     * True when `pictureTarget` is a raster fallback chosen because the
     * original `<a:blip r:embed>` resolved to a `.emf` / `.wmf` zip entry
     * that the browser cannot render natively.
     */
    vectorFallback?: boolean;
    fillColor?: string;
    borderColor?: string;
    /**
     * Table cells flattened to plain text. Merged cells surface as their text
     * in the top-left cell with empty strings in the merged-away cells
     * (placeholder behaviour; full row/col span info is not preserved).
     */
    tableRows?: string[][];
    /** Chart variant identifier — currently `'stackedColumn'` or `'line'`. */
    chartKind?: string;
    chartTitle?: string;
    chartData?: PptxChartData;
    // -------------------------------------------------------------------
    // Shape geometry fields (issue #75)
    // -------------------------------------------------------------------
    /** OOXML `<a:prstGeom prst="…">` preset name, e.g. `"rect"`, `"ellipse"`, `"roundRect"`, `"straightConnector1"`. */
    presetGeom?: string;
    /**
     * Resolved SVG `<path d="…">` string for `<a:custGeom>` shapes, scaled to
     * the shape's width/height in **px** (path-local space `w`/`h` are mapped
     * onto the shape box). Supported path commands: `moveTo`, `lnTo`,
     * `cubicBezTo`, `close`. Arcs (`arcTo`), quad-bezier (`quadBezTo`), and
     * fill-mode hints are intentionally not supported — matches the VSCode
     * reference's silent-skip behaviour.
     */
    customSvgPath?: string;
    /** OOXML `<a:headEnd type="…">` arrow head type (e.g. `"triangle"`, `"arrow"`, `"stealth"`, `"diamond"`, `"oval"`, `"none"`). `undefined` when the tag is absent. */
    headEnd?: string;
    /** OOXML `<a:tailEnd type="…">` arrow tail type (same vocabulary as `headEnd`). `undefined` when the tag is absent. */
    tailEnd?: string;
    /** True when the shape's `<a:xfrm flipH="1"/>`; renderer mirrors horizontally. */
    flipH?: boolean;
    /** True when the shape's `<a:xfrm flipV="1"/>`; renderer mirrors vertically. */
    flipV?: boolean;
    /** Stroke width in pixels parsed from `<a:ln w="…">` (EMU / 12700). `undefined` when `<a:ln>` is absent or has no `w` attribute. Never negative. */
    borderWidthPx?: number;
    /**
     * OOXML `<a:prstDash val="…">` preset dash name (issue #77). Common values:
     * `'solid'`, `'dot'`, `'dash'`, `'dashDot'`, `'lgDash'`, `'lgDashDot'`,
     * `'lgDashDotDot'`, `'sysDash'`, `'sysDot'`, `'sysDashDot'`, `'sysDashDotDot'`.
     * `undefined` when the source has no `<a:prstDash>` (renderer assumes
     * solid). The renderer maps the preset name to a CSS / SVG dash array;
     * the parser does not interpret the values itself so the mapping stays
     * in one place.
     */
    borderDash?: string;
    /**
     * Parsed `<a:gradFill>` (issue #77). Mutually consistent with `fillColor`
     * — when both are set the renderer prefers `gradientFill`. `undefined` for
     * shapes with no gradient. Solid-fill / no-fill cases are unaffected.
     */
    gradientFill?: PptxGradientFill;
    /**
     * OOXML `<a:bodyPr anchor="t|ctr|b"/>` text vertical anchor (issue #77).
     * `undefined` when the source has no explicit anchor (renderer falls back
     * to the title=center / body=top approximation). Values are normalised to
     * `'t'` (top), `'ctr'` (center), or `'b'` (bottom); unknown values pass
     * through verbatim so future OOXML revisions stay round-trip-able.
     */
    anchor?: string;
}

export interface PptxSlide {
    slideNumber: number;
    widthPx: number;
    heightPx: number;
    backgroundColor: string;
    shapes: PptxShape[];
}

export interface PptxDocument {
    slides: PptxSlide[];
    totalSlides: number;
    /** Raw zip handle so the renderer can resolve picture bytes lazily. */
    zip: PptxZip;
}

// ---------------------------------------------------------------------------
// Duck-typed JSZip interface
// ---------------------------------------------------------------------------

/**
 * Minimal subset of JSZip we rely on. The runtime instance from
 * `vendor/jszip.min.js` satisfies this shape; tests can construct a stub
 * without pulling JSZip into the jest harness.
 */
export interface PptxZipFile {
    /** Read the entry as a UTF-8 string. */
    async(type: 'text'): Promise<string>;
    /** Read the entry as raw bytes. */
    async(type: 'uint8array'): Promise<Uint8Array>;
    /** Read the entry as a base64 string (used by the legacy code path). */
    async(type: 'base64'): Promise<string>;
}

export interface PptxZip {
    file(path: string): PptxZipFile | null;
    files: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface Relationship {
    id: string;
    target: string;
    type: string;
}

interface Transform {
    offX: number;
    offY: number;
    scaleX: number;
    scaleY: number;
    rotDeg: number;
}

interface ThemeInfo {
    colors: Record<string, string>;
}

interface ColorContext {
    themeColors: Record<string, string>;
    clrMap: Record<string, string>;
}

const ZERO_TX: Transform = {
    offX: 0,
    offY: 0,
    scaleX: 1,
    scaleY: 1,
    rotDeg: 0
};

const DEFAULT_THEME_COLORS: Record<string, string> = {
    lt1: '#ffffff',
    dk1: '#000000',
    lt2: '#eeeeee',
    dk2: '#222222',
    accent1: '#4472c4',
    accent2: '#ed7d31',
    accent3: '#a5a5a5',
    accent4: '#ffc000',
    accent5: '#5b9bd5',
    accent6: '#70ad47'
};

const DEFAULT_CLR_MAP: Record<string, string> = {
    bg1: 'lt1',
    tx1: 'dk1',
    bg2: 'lt2',
    tx2: 'dk2',
    accent1: 'accent1',
    accent2: 'accent2',
    accent3: 'accent3',
    accent4: 'accent4',
    accent5: 'accent5',
    accent6: 'accent6',
    hlink: 'hlink',
    folHlink: 'folHlink'
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class PptxXmlParser {
    /**
     * Top-level entry: parse a PPTX `File` (browser File API) and return a
     * structured document tree. The viewer is responsible for loading JSZip
     * from `vendor/jszip.min.js` first and passing the constructor in.
     */
    public static async parseFile(
        file: File,
        jsZipCtor: { loadAsync(data: ArrayBuffer): Promise<PptxZip> }
    ): Promise<PptxDocument> {
        const buffer = await file.arrayBuffer();
        const zip = await jsZipCtor.loadAsync(buffer);
        return this.parseZip(zip);
    }

    /**
     * Test-friendly entry: parse an already-loaded zip.
     */
    public static async parseZip(zip: PptxZip): Promise<PptxDocument> {
        const size = await this.getSlideSize(zip);
        const slidePaths = await this.getOrderedSlidePaths(zip);

        const slides: PptxSlide[] = [];
        for (let i = 0; i < slidePaths.length; i++) {
            const parsed = await this.parseSingleSlide(zip, slidePaths[i], i + 1, size);
            slides.push(parsed);
        }

        return {
            slides,
            totalSlides: slides.length,
            zip
        };
    }

    // -------------------------------------------------------------------
    // Slide assembly
    // -------------------------------------------------------------------

    private static async parseSingleSlide(
        zip: PptxZip,
        slidePath: string,
        slideNumber: number,
        size: { widthPx: number; heightPx: number }
    ): Promise<PptxSlide> {
        const slideXml = await this.readZipText(zip, slidePath);
        const slideRels = await this.getRelationships(zip, slidePath);

        const layoutPath = slideRels.find((r) => r.type.includes('/slideLayout'))?.target;
        const layoutXml = layoutPath ? await this.readZipText(zip, layoutPath) : '';
        const layoutRels = layoutPath ? await this.getRelationships(zip, layoutPath) : [];

        const masterPath = layoutRels.find((r) => r.type.includes('/slideMaster'))?.target;
        const masterXml = masterPath ? await this.readZipText(zip, masterPath) : '';
        const masterRels = masterPath ? await this.getRelationships(zip, masterPath) : [];

        const themePath = masterRels.find((r) => r.type.includes('/theme'))?.target;
        const themeXml = themePath ? await this.readZipText(zip, themePath) : '';
        const theme = this.parseTheme(themeXml);
        const colorCtx = this.buildColorContext(theme, masterXml, layoutXml, slideXml);

        const backgroundColor =
            this.extractBackgroundColor(slideXml, colorCtx)
            || this.extractBackgroundColor(layoutXml, colorCtx)
            || this.extractBackgroundColor(masterXml, colorCtx)
            || '#ffffff';

        // Pre-load chart parts referenced from the slide rels so the
        // synchronous `extractShapesFromPart` can resolve `<c:chart r:id>`
        // without needing async access to the zip. Charts only live at the
        // slide level; master/layout rels are intentionally ignored.
        const chartXmls = await this.loadChartXmls(zip, slideRels);

        const masterShapes = this.extractShapesFromPart(masterXml, masterRels, colorCtx, 1);
        const layoutShapes = this.extractShapesFromPart(layoutXml, layoutRels, colorCtx, 2);
        const slideShapes = this.extractShapesFromPart(slideXml, slideRels, colorCtx, 3, chartXmls);

        const merged = this.mergeWithPlaceholderInheritance([
            ...masterShapes,
            ...layoutShapes,
            ...slideShapes
        ]);

        this.applyVectorFallbacks(zip, merged);

        return {
            slideNumber,
            widthPx: size.widthPx,
            heightPx: size.heightPx,
            backgroundColor,
            shapes: merged
        };
    }

    /**
     * For each picture shape whose `pictureTarget` is an EMF/WMF entry,
     * substitute a sibling raster fallback (same base name, raster
     * extension) when the zip contains one and flag the shape with
     * `vectorFallback = true`. Mutates `shapes` in place; shapes without
     * `pictureTarget` or with a renderable raster target are left alone.
     */
    private static applyVectorFallbacks(zip: PptxZip, shapes: PptxShape[]): void {
        for (const shape of shapes) {
            if (shape.kind !== 'picture' || !shape.pictureTarget) continue;
            const fallback = this.findVectorRasterFallback(zip, shape.pictureTarget);
            if (!fallback) continue;
            shape.pictureTarget = fallback;
            shape.pictureMime = this.getMimeTypeByExtension(fallback);
            shape.vectorFallback = true;
        }
    }

    // -------------------------------------------------------------------
    // Placeholder inheritance (title vs body branch only)
    // -------------------------------------------------------------------

    static mergeWithPlaceholderInheritance(elements: PptxShape[]): PptxShape[] {
        const placeholders = new Map<string, PptxShape>();
        const others: PptxShape[] = [];

        const sorted = [...elements].sort((a, b) => {
            if (a.sourcePriority !== b.sourcePriority) {
                return a.sourcePriority - b.sourcePriority;
            }
            return a.zIndex - b.zIndex;
        });

        for (const element of sorted) {
            if (!element.placeholderKey) {
                others.push(element);
                continue;
            }
            const prev = placeholders.get(element.placeholderKey);
            if (!prev) {
                placeholders.set(element.placeholderKey, element);
                continue;
            }
            placeholders.set(element.placeholderKey, this.mergePlaceholderElement(prev, element));
        }

        const merged = [...others, ...Array.from(placeholders.values())];
        merged.sort((a, b) => {
            if (a.sourcePriority !== b.sourcePriority) {
                return a.sourcePriority - b.sourcePriority;
            }
            return a.zIndex - b.zIndex;
        });

        return merged.map((el, idx) => ({ ...el, zIndex: idx }));
    }

    private static mergePlaceholderElement(base: PptxShape, incoming: PptxShape): PptxShape {
        const incomingHasGeom = this.hasValidGeometry(incoming);
        const incomingParagraphs = incoming.paragraphs && incoming.paragraphs.length > 0
            ? incoming.paragraphs
            : base.paragraphs;
        return {
            ...base,
            ...incoming,
            kind: incoming.kind === 'placeholder' && (base.kind === 'text' || base.kind === 'picture')
                ? base.kind
                : incoming.kind,
            x: incomingHasGeom ? incoming.x : base.x,
            y: incomingHasGeom ? incoming.y : base.y,
            width: incomingHasGeom ? incoming.width : base.width,
            height: incomingHasGeom ? incoming.height : base.height,
            rotateDeg: incomingHasGeom ? incoming.rotateDeg : base.rotateDeg,
            paragraphs: incomingParagraphs,
            isTitle: incoming.isTitle || base.isTitle,
            pictureTarget: incoming.pictureTarget || base.pictureTarget,
            pictureMime: incoming.pictureMime || base.pictureMime,
            srcRect: incoming.srcRect || base.srcRect,
            vectorFallback: incoming.vectorFallback || base.vectorFallback,
            fillColor: incoming.fillColor || base.fillColor,
            gradientFill: incoming.gradientFill || base.gradientFill,
            borderColor: incoming.borderColor || base.borderColor,
            borderWidthPx: incoming.borderWidthPx !== undefined ? incoming.borderWidthPx : base.borderWidthPx,
            borderDash: incoming.borderDash || base.borderDash,
            anchor: incoming.anchor || base.anchor
        };
    }

    private static hasValidGeometry(el: PptxShape): boolean {
        return Number.isFinite(el.width) && Number.isFinite(el.height) && el.width > 0 && el.height > 0;
    }

    // -------------------------------------------------------------------
    // Shape extraction
    // -------------------------------------------------------------------

    static extractShapesFromPart(
        partXml: string,
        rels: Relationship[],
        colors: ColorContext,
        sourcePriority: number,
        chartXmls?: Map<string, string>
    ): PptxShape[] {
        if (!partXml) return [];

        const tree = this.extractTagBlock(partXml, 'p:spTree');
        if (!tree) return [];

        const result: PptxShape[] = [];
        this.collectBlocks(tree, rels, colors, sourcePriority, ZERO_TX, result, { value: 0 }, chartXmls);
        return result;
    }

    private static collectBlocks(
        xml: string,
        rels: Relationship[],
        colors: ColorContext,
        sourcePriority: number,
        parentTx: Transform,
        out: PptxShape[],
        zCounter: { value: number },
        chartXmls?: Map<string, string>
    ): void {
        const tagNames = ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp', 'p:cxnSp'];
        let cursor = 0;

        while (cursor < xml.length) {
            let nextIdx = -1;
            let foundTag = '';

            for (const tag of tagNames) {
                const idx = this.findNextTagIndex(xml, tag, cursor);
                if (idx !== -1 && (nextIdx === -1 || idx < nextIdx)) {
                    nextIdx = idx;
                    foundTag = tag;
                }
            }

            if (nextIdx === -1) break;

            const block = this.extractBalancedTag(xml, foundTag, nextIdx);
            if (!block) {
                cursor = nextIdx + foundTag.length;
                continue;
            }

            if (foundTag === 'p:grpSp') {
                const grpTx = this.combineTransforms(parentTx, this.parseGroupTransform(block.content));
                this.collectBlocks(block.innerContent, rels, colors, sourcePriority, grpTx, out, zCounter, chartXmls);
            } else if (foundTag === 'p:sp' || foundTag === 'p:cxnSp') {
                const element = this.parseShapeBlock(block.content, rels, colors, sourcePriority, parentTx, zCounter.value);
                if (element) {
                    out.push(element);
                    zCounter.value += 1;
                }
            } else if (foundTag === 'p:pic') {
                const element = this.parsePictureBlock(block.content, rels, sourcePriority, parentTx, zCounter.value);
                if (element) {
                    out.push(element);
                    zCounter.value += 1;
                }
            } else if (foundTag === 'p:graphicFrame') {
                const element = this.parseGraphicFrameBlock(block.content, rels, colors, sourcePriority, parentTx, zCounter.value, chartXmls);
                if (element) {
                    out.push(element);
                    zCounter.value += 1;
                }
            }

            cursor = block.end;
        }
    }

    private static parseShapeBlock(
        shapeXml: string,
        _rels: Relationship[],
        colors: ColorContext,
        sourcePriority: number,
        parentTx: Transform,
        zIndex: number
    ): PptxShape | null {
        const placeholderType = this.getPlaceholderType(shapeXml);
        // Footer/date/slide-number placeholders living in master/layout
        // should not render unless the slide explicitly overrides them.
        if (sourcePriority < 3 && (placeholderType === 'dt' || placeholderType === 'ftr' || placeholderType === 'sldnum')) {
            return null;
        }

        const localGeom = this.parseGeometry(shapeXml);
        const geom = localGeom ? this.applyTransform(localGeom, parentTx) : null;

        const placeholderKey = this.getPlaceholderKey(shapeXml);
        const isTitle = this.isTitleShape(shapeXml);
        const paragraphs = this.extractTextParagraphs(shapeXml, colors);

        // Master / layout prompt text (e.g. "Click to edit master title style")
        // should not be rendered when the slide does not override the
        // placeholder. We still keep the geometry so the layout cascade has
        // something to fall back to.
        if (paragraphs.length > 0 && sourcePriority < 3) {
            const onlyPrompt = paragraphs.every((p) => this.isPlaceholderPromptText(p.text));
            if (onlyPrompt) {
                if (placeholderKey && geom) {
                    return {
                        kind: 'placeholder',
                        x: geom.x,
                        y: geom.y,
                        width: geom.width,
                        height: geom.height,
                        rotateDeg: geom.rotateDeg,
                        zIndex,
                        sourcePriority,
                        placeholderKey,
                        isTitle
                    };
                }
                return null;
            }
        }

        const fillColor = this.extractFillColor(shapeXml, colors);
        const gradientFill = this.extractGradientFill(shapeXml, colors);
        const borderColor = this.extractLineColor(shapeXml, colors);
        const presetGeom = shapeXml.match(/<a:prstGeom\b[^>]*prst="([^"]+)"/)?.[1];
        const customSvgPath = geom ? this.parseCustomGeometryPath(shapeXml, geom.width, geom.height) : undefined;
        const headEnd = shapeXml.match(/<a:headEnd\b[^>]*type="([^"]+)"/)?.[1];
        const tailEnd = shapeXml.match(/<a:tailEnd\b[^>]*type="([^"]+)"/)?.[1];
        const borderWidthPx = this.extractLineWidthPx(shapeXml);
        const borderDash = this.extractLineDash(shapeXml);
        const anchor = this.extractBodyAnchor(shapeXml);

        if (paragraphs.length > 0) {
            return {
                kind: 'text',
                x: geom ? geom.x : 0,
                y: geom ? geom.y : 0,
                width: geom ? geom.width : 0,
                height: geom ? geom.height : 0,
                rotateDeg: geom?.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey,
                isTitle,
                paragraphs,
                fillColor,
                gradientFill,
                borderColor,
                flipH: geom?.flipH,
                flipV: geom?.flipV,
                borderWidthPx,
                borderDash,
                anchor
            };
        }

        // Shape with no text — keep it as a placeholder so layout boxes
        // (e.g. body content slots) don't disappear.
        if (placeholderKey && geom) {
            return {
                kind: 'placeholder',
                x: geom.x,
                y: geom.y,
                width: geom.width,
                height: geom.height,
                rotateDeg: geom.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey,
                isTitle,
                fillColor,
                gradientFill,
                borderColor
            };
        }

        // Renderable shape on the slide itself (preset/custom geometry, line
        // connector, or styled rectangle). Issue #75 promotes these from the
        // previous flat `placeholder` fallback to a typed `shape` kind so the
        // renderer can paint inline SVG.
        if (geom && (fillColor || gradientFill || borderColor || presetGeom || customSvgPath)) {
            return {
                kind: 'shape',
                x: geom.x,
                y: geom.y,
                width: geom.width,
                height: geom.height,
                rotateDeg: geom.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey,
                fillColor,
                gradientFill,
                borderColor,
                presetGeom,
                customSvgPath,
                headEnd,
                tailEnd,
                flipH: geom.flipH,
                flipV: geom.flipV,
                borderWidthPx,
                borderDash
            };
        }

        return null;
    }

    /**
     * Parse `<a:ln w="…">` stroke width from a shape's `p:spPr`. OOXML stores
     * the width in EMU; one px ≈ 12700 EMU at the OOXML reference DPI. Returns
     * `undefined` when `<a:ln>` is absent or has no `w` attribute. Negative
     * widths are clamped to 0.
     */
    static extractLineWidthPx(xml: string): number | undefined {
        const spPr = this.extractTagBlock(xml, 'p:spPr') || xml;
        const lnOpen = spPr.match(/<a:ln\b[^>]*>/)?.[0] || spPr.match(/<a:ln\b[^>]*\/>/)?.[0];
        if (!lnOpen) return undefined;
        const raw = this.getAttr(lnOpen, 'w');
        if (raw === undefined) return undefined;
        const emu = Number(raw);
        if (!Number.isFinite(emu)) return undefined;
        const px = emu / 12700;
        return px < 0 ? 0 : Math.round(px * 1000) / 1000;
    }

    /**
     * Parse `<a:custGeom>` path data into a single SVG `d=` string scaled to
     * the shape's pixel width/height. Supports `moveTo`, `lnTo`, `cubicBezTo`,
     * and `close`. Unsupported commands (`arcTo`, `quadBezTo`, etc.) are
     * silently skipped — matches the VSCode reference's behaviour. Returns
     * `undefined` when the tag is absent, the path block is empty, or
     * `width <= 0` / `height <= 0`.
     */
    static parseCustomGeometryPath(shapeXml: string, width: number, height: number): string | undefined {
        const custGeom = this.extractTagBlock(shapeXml, 'a:custGeom');
        if (!custGeom || width <= 0 || height <= 0) return undefined;

        const pathBlocks = custGeom.match(/<a:path\b[\s\S]*?<\/a:path>/g) || [];
        if (pathBlocks.length === 0) return undefined;

        const pathData: string[] = [];
        for (const pathBlock of pathBlocks) {
            const rawW = Number(this.getAttr(pathBlock, 'w') || 0);
            const rawH = Number(this.getAttr(pathBlock, 'h') || 0);
            const scaleX = rawW > 0 ? width / rawW : 1;
            const scaleY = rawH > 0 ? height / rawH : 1;
            const commandBlocks = pathBlock.match(
                /<a:(?:moveTo|lnTo|cubicBezTo)\b[\s\S]*?<\/a:(?:moveTo|lnTo|cubicBezTo)>|<a:close\s*\/>/g
            ) || [];

            for (const commandBlock of commandBlocks) {
                if (commandBlock.startsWith('<a:moveTo')) {
                    const pt = this.extractPathPoint(commandBlock, 0, scaleX, scaleY);
                    if (pt) pathData.push(`M ${pt.x} ${pt.y}`);
                } else if (commandBlock.startsWith('<a:lnTo')) {
                    const pt = this.extractPathPoint(commandBlock, 0, scaleX, scaleY);
                    if (pt) pathData.push(`L ${pt.x} ${pt.y}`);
                } else if (commandBlock.startsWith('<a:cubicBezTo')) {
                    const p1 = this.extractPathPoint(commandBlock, 0, scaleX, scaleY);
                    const p2 = this.extractPathPoint(commandBlock, 1, scaleX, scaleY);
                    const p3 = this.extractPathPoint(commandBlock, 2, scaleX, scaleY);
                    if (p1 && p2 && p3) {
                        pathData.push(`C ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`);
                    }
                } else if (commandBlock.startsWith('<a:close')) {
                    pathData.push('Z');
                }
            }
        }

        return pathData.length > 0 ? pathData.join(' ') : undefined;
    }

    private static extractPathPoint(
        xml: string,
        index: number,
        scaleX: number,
        scaleY: number
    ): { x: number; y: number } | null {
        const pointTags = xml.match(/<a:pt\b[^>]*x="[^"]+"[^>]*y="[^"]+"[^>]*\/>/g) || [];
        const pointTag = pointTags[index];
        if (!pointTag) return null;

        const x = Number(this.getAttr(pointTag, 'x') || 0);
        const y = Number(this.getAttr(pointTag, 'y') || 0);
        return {
            x: Math.round(x * scaleX * 1000) / 1000,
            y: Math.round(y * scaleY * 1000) / 1000
        };
    }

    private static parsePictureBlock(
        picXml: string,
        rels: Relationship[],
        sourcePriority: number,
        parentTx: Transform,
        zIndex: number
    ): PptxShape | null {
        const localGeom = this.parseGeometry(picXml);
        const geom = localGeom ? this.applyTransform(localGeom, parentTx) : null;
        const placeholderKey = this.getPlaceholderKey(picXml);

        const embedId = picXml.match(/<a:blip[^>]*r:embed="([^"]+)"/)?.[1];
        if (!embedId) {
            if (!geom) return null;
            return {
                kind: 'placeholder',
                x: geom.x,
                y: geom.y,
                width: geom.width,
                height: geom.height,
                rotateDeg: geom.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey
            };
        }

        const target = rels.find((r) => r.id === embedId)?.target;
        if (!target || !geom) {
            return null;
        }

        const srcRect = this.parseSrcRect(picXml);

        return {
            kind: 'picture',
            x: geom.x,
            y: geom.y,
            width: geom.width,
            height: geom.height,
            rotateDeg: geom.rotateDeg,
            zIndex,
            sourcePriority,
            placeholderKey,
            pictureTarget: target,
            pictureMime: this.getMimeTypeByExtension(target),
            srcRect
        };
    }

    // -------------------------------------------------------------------
    // graphicFrame: tables, charts, SmartArt placeholders (issue #74)
    // -------------------------------------------------------------------

    /**
     * Parse a `<p:graphicFrame>` block into a table / chart / diagram shape.
     * Branches on `<a:graphicData uri>`:
     *
     *   - `.../relationships/table`   → `kind: 'table'`, `tableRows` populated.
     *   - `.../relationships/chart`   → `kind: 'chart'`, optional `chartData`
     *                                   parsed from a pre-loaded chart part.
     *   - `.../relationships/diagram` → `kind: 'diagram'` (SmartArt placeholder
     *                                   — geometry only, no layout reconstruction).
     *
     * Other URIs (embedded OLE objects etc.) are dropped — the renderer has
     * no story for them and the VSCode reference renders them as opaque
     * grey boxes which adds noise without value.
     */
    static parseGraphicFrameBlock(
        frameXml: string,
        rels: Relationship[],
        colors: ColorContext,
        sourcePriority: number,
        parentTx: Transform,
        zIndex: number,
        chartXmls?: Map<string, string>
    ): PptxShape | null {
        const localGeom = this.parseGeometry(frameXml);
        if (!localGeom) return null;
        const geom = this.applyTransform(localGeom, parentTx);
        const placeholderKey = this.getPlaceholderKey(frameXml);

        const uri = frameXml.match(/<a:graphicData[^>]*uri="([^"]+)"/)?.[1] || '';

        if (/\/relationships\/table\b/.test(uri) || uri.endsWith('/table')) {
            const tableRows = this.extractTableRows(frameXml);
            if (tableRows.length === 0) return null;
            return {
                kind: 'table',
                x: geom.x,
                y: geom.y,
                width: geom.width,
                height: geom.height,
                rotateDeg: geom.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey,
                tableRows
            };
        }

        if (/\/relationships\/chart\b/.test(uri) || uri.endsWith('/chart')) {
            const chartRelId = frameXml.match(/<c:chart[^>]*r:id="([^"]+)"/)?.[1] || '';
            let chartTitle: string | undefined;
            let chartKind: string | undefined;
            let chartData: PptxChartData | undefined;

            if (chartRelId) {
                const chartXml = chartXmls?.get(chartRelId) || '';
                if (chartXml) {
                    const rawTitle = chartXml.match(/<c:title[\s\S]*?<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>/)?.[1];
                    if (rawTitle) chartTitle = this.decodeXmlEntities(rawTitle);
                    chartData = this.parseChartData(chartXml, colors);
                    if (chartData) chartKind = chartData.kind;
                }
            }

            return {
                kind: 'chart',
                x: geom.x,
                y: geom.y,
                width: geom.width,
                height: geom.height,
                rotateDeg: geom.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey,
                chartKind,
                chartTitle,
                chartData
            };
        }

        if (/\/relationships\/diagram\b/.test(uri) || uri.endsWith('/diagram')) {
            return {
                kind: 'diagram',
                x: geom.x,
                y: geom.y,
                width: geom.width,
                height: geom.height,
                rotateDeg: geom.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey,
                chartTitle: 'SmartArt'
            };
        }

        return null;
    }

    /**
     * Extract cell text from a `<p:graphicFrame>` table body. Returns one
     * string per `<a:tc>` cell, joining all `<a:t>` runs with single spaces.
     * Merged cells: the source text appears in the merged anchor cell; cells
     * marked with `hMerge="1"` / `vMerge="1"` surface as empty strings so
     * downstream renderers can still produce a regular grid.
     */
    static extractTableRows(xml: string): string[][] {
        const rows: string[][] = [];
        const trMatches = xml.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) || [];
        for (const tr of trMatches) {
            const row: string[] = [];
            const tcMatches = tr.match(/<a:tc\b[\s\S]*?<\/a:tc>/g) || [];
            for (const tc of tcMatches) {
                const openTag = tc.match(/<a:tc\b[^>]*>/)?.[0] || '';
                const merged = this.getAttr(openTag, 'hMerge') === '1' || this.getAttr(openTag, 'vMerge') === '1';
                if (merged) {
                    row.push('');
                    continue;
                }
                const texts: string[] = [];
                const tMatches = tc.match(/<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>/g) || [];
                for (const t of tMatches) {
                    const value = t.match(/<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>/)?.[1] || '';
                    if (value) texts.push(this.decodeXmlEntities(value));
                }
                row.push(texts.join(' ').trim());
            }
            if (row.length > 0) rows.push(row);
        }
        return rows;
    }

    /**
     * Pre-load all chart parts referenced by `chart` relationships in a part's
     * rels list. Returns a `Map<relId, chartXml>` so a later (synchronous)
     * shape walk can resolve `<c:chart r:id>` without re-touching the zip.
     */
    static async loadChartXmls(zip: PptxZip, rels: Relationship[]): Promise<Map<string, string>> {
        const map = new Map<string, string>();
        for (const rel of rels) {
            if (!rel.type.includes('/chart')) continue;
            // Only chart parts — skip chartUserShapes etc. by sanity-checking
            // the target extension. The relationship type for a chart part is
            // `.../relationships/chart` and the target is `charts/chartN.xml`.
            if (!/\.xml$/i.test(rel.target)) continue;
            try {
                const xml = await this.readZipText(zip, rel.target);
                if (xml) map.set(rel.id, xml);
            } catch {
                // best-effort — a missing chart part just leaves chartData undefined.
            }
        }
        return map;
    }

    /**
     * Parse the minimum-viable chart payload out of a `ppt/charts/chartN.xml`
     * part. Supports `<c:barChart>` with `grouping="stacked"` + `barDir="col"`
     * and `<c:lineChart>`. Anything else returns `undefined` (the parent
     * graphicFrame still emits a `kind: 'chart'` shape so the renderer can
     * draw a labelled placeholder).
     */
    static parseChartData(chartXml: string, colors: ColorContext): PptxChartData | undefined {
        if (!chartXml) return undefined;

        const lineChart = this.extractTagBlock(chartXml, 'c:lineChart');
        if (lineChart) {
            const parsed = this.parseSeriesBased(lineChart, colors, 'line');
            if (parsed) return parsed;
        }

        const barChart = this.extractTagBlock(chartXml, 'c:barChart');
        if (barChart) {
            const grouping = barChart.match(/<c:grouping[^>]*val="([^"]+)"/)?.[1] || '';
            const barDir = barChart.match(/<c:barDir[^>]*val="([^"]+)"/)?.[1] || '';
            if (grouping === 'stacked' && barDir === 'col') {
                const parsed = this.parseSeriesBased(barChart, colors, 'stackedColumn');
                if (parsed) return parsed;
            }
        }

        return undefined;
    }

    /**
     * Shared series/category extraction for bar + line charts. Returns
     * `undefined` when the chart part has no `<c:ser>` entries (so the
     * caller emits a placeholder-only shape).
     */
    private static parseSeriesBased(
        chartBlockXml: string,
        _colors: ColorContext,
        kind: 'stackedColumn' | 'line'
    ): PptxChartData | undefined {
        const serBlocks = chartBlockXml.match(/<c:ser\b[\s\S]*?<\/c:ser>/g) || [];
        if (serBlocks.length === 0) return undefined;

        let categories: string[] = [];
        const series = serBlocks.map((serXml, idx) => {
            const nameRaw = serXml.match(/<c:tx[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/)?.[1];
            const name = nameRaw ? this.decodeXmlEntities(nameRaw) : `Series ${idx + 1}`;

            if (categories.length === 0) {
                const categoryPts = serXml.match(/<c:cat[\s\S]*?<\/c:cat>/)?.[0] || '';
                categories = this.extractChartPoints(categoryPts);
            }

            const valuePts = serXml.match(/<c:val[\s\S]*?<\/c:val>/)?.[0] || '';
            const values = this.extractChartNumericPoints(valuePts, categories.length || undefined);
            return { name, values };
        });

        if (categories.length === 0) {
            const maxLen = Math.max(...series.map((s) => s.values.length));
            categories = Array.from({ length: maxLen }, (_, i) => `${i + 1}`);
        }

        const normalizedSeries = series.map((s) => ({
            name: s.name,
            values: this.padValues(s.values, categories.length)
        }));

        return {
            kind,
            categories,
            series: normalizedSeries
        };
    }

    private static extractChartPoints(xml: string): string[] {
        if (!xml) return [];
        const out: { idx: number; value: string }[] = [];
        const pts = xml.match(/<c:pt\b[\s\S]*?<\/c:pt>/g) || [];
        pts.forEach((pt) => {
            const idx = Number(pt.match(/idx="(\d+)"/)?.[1] || 0);
            const raw = pt.match(/<c:v>([\s\S]*?)<\/c:v>/)?.[1] || '';
            out.push({ idx, value: this.decodeXmlEntities(raw) });
        });
        out.sort((a, b) => a.idx - b.idx);
        return out.map((p) => p.value);
    }

    private static extractChartNumericPoints(xml: string, fallbackLength?: number): number[] {
        const values: number[] = [];
        if (!xml) return fallbackLength ? Array.from({ length: fallbackLength }, () => 0) : values;

        const pts = xml.match(/<c:pt\b[\s\S]*?<\/c:pt>/g) || [];
        pts.forEach((pt) => {
            const idx = Number(pt.match(/idx="(\d+)"/)?.[1] || 0);
            const raw = pt.match(/<c:v>([\s\S]*?)<\/c:v>/)?.[1] || '';
            const n = Number(raw);
            if (!Number.isNaN(n)) values[idx] = n;
        });

        if (fallbackLength && values.length < fallbackLength) {
            for (let i = 0; i < fallbackLength; i++) {
                if (!Number.isFinite(values[i])) values[i] = 0;
            }
        }

        return values.map((v) => (Number.isFinite(v) ? v : 0));
    }

    private static padValues(values: number[], length: number): number[] {
        return Array.from({ length }, (_, i) => values[i] || 0);
    }

    /**
     * Parse `<a:srcRect l="" t="" r="" b=""/>` from a `<p:pic>` block.
     * OOXML stores each edge in 1/1000th of a percent; we normalise to
     * straight percentages (0–100) so the renderer can plug the values
     * directly into CSS `%` units. Returns `undefined` when the tag is
     * absent or all four edges are zero.
     */
    static parseSrcRect(picXml: string): { l: number; t: number; r: number; b: number } | undefined {
        const srcRectTag = picXml.match(/<a:srcRect\b[^>]*\/?>/)?.[0];
        if (!srcRectTag) return undefined;

        const toPct = (name: string): number => {
            const raw = Number(this.getAttr(srcRectTag, name) || 0);
            return Number.isFinite(raw) ? raw / 1000 : 0;
        };
        const l = toPct('l');
        const t = toPct('t');
        const r = toPct('r');
        const b = toPct('b');
        if (!l && !t && !r && !b) return undefined;
        return { l, t, r, b };
    }

    /**
     * Resolve an EMF/WMF picture target to an in-package raster fallback,
     * when one exists. Browsers cannot render EMF/WMF natively, but Office
     * tools usually emit a sibling PNG/JPG/JPEG/WebP/GIF alongside the
     * vector original. Returns `null` (no fallback) when the source is not
     * EMF/WMF, when no sibling raster exists, or when the source extension
     * cannot be parsed.
     */
    static findVectorRasterFallback(zip: PptxZip, target: string): string | null {
        const dot = target.lastIndexOf('.');
        if (dot === -1) return null;
        const ext = target.slice(dot).toLowerCase();
        if (ext !== '.emf' && ext !== '.wmf') return null;

        const slash = target.lastIndexOf('/');
        const dir = slash === -1 ? '' : target.slice(0, slash);
        const base = target.slice(slash + 1, dot);
        const prefix = dir ? `${dir}/${base}` : base;

        const candidates = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
        for (const candidate of candidates) {
            const path = `${prefix}${candidate}`;
            if (zip.file(path)) return path;
        }
        return null;
    }

    // -------------------------------------------------------------------
    // Text / runs / paragraphs
    // -------------------------------------------------------------------

    static extractTextParagraphs(shapeXml: string, colors: ColorContext): PptxParagraph[] {
        const paragraphs: PptxParagraph[] = [];

        const txBody = this.extractTagBlock(shapeXml, 'p:txBody') || shapeXml;
        const lstStyle = this.extractTagBlock(txBody, 'a:lstStyle') || '';
        const pMatches = txBody.match(/<a:p\b[\s\S]*?<\/a:p>/g) || [];

        for (const pXml of pMatches) {
            const textParts: string[] = [];
            const runs: PptxRun[] = [];
            const runMatches = pXml.match(/<a:r\b[\s\S]*?<\/a:r>|<a:fld\b[\s\S]*?<\/a:fld>|<a:t(?=[\s>])[^>]*>[\s\S]*?<\/a:t>/g) || [];
            let lastRun = '';

            for (const run of runMatches) {
                if (run.startsWith('<a:r') || run.startsWith('<a:fld')) {
                    lastRun = run;
                    const t = run.match(/<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>/)?.[1];
                    if (t !== undefined) {
                        const text = this.decodeXmlEntities(t);
                        textParts.push(text);
                        const runRPr = run.match(/<a:rPr[^>]*\/?>/)?.[0] || '';
                        const runSz = Number(this.getAttr(runRPr, 'sz') || 0);
                        runs.push({
                            text,
                            fontSizePx: runSz > 0 ? Math.round((runSz / 100) * 1.333) : undefined,
                            bold: this.parseOptionalBoolAttr(runRPr, 'b'),
                            italic: this.parseOptionalBoolAttr(runRPr, 'i'),
                            color: this.extractColorFromXml(runRPr + run, colors)
                        });
                    }
                } else {
                    const t = run.match(/<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>/)?.[1];
                    if (t !== undefined) {
                        const text = this.decodeXmlEntities(t);
                        textParts.push(text);
                        runs.push({ text });
                    }
                }
            }

            const text = textParts.join('').trim();
            if (!text) continue;

            const inlinePPr = pXml.match(/<a:pPr[^>]*\/?>/)?.[0] || '';
            const inlineLevel = Number(this.getAttr(inlinePPr, 'lvl') || 0);
            const level = Number.isFinite(inlineLevel) ? inlineLevel : 0;
            const levelStyle = this.extractParagraphLevelStyle(lstStyle, level);
            const levelPPr = levelStyle.match(/<a:lvl\d+pPr[^>]*>/)?.[0] || '';
            const pPr = inlinePPr || levelPPr;
            const levelRPr = levelStyle.match(/<a:defRPr[^>]*\/?>/)?.[0] || '';
            const rPr = lastRun.match(/<a:rPr[^>]*\/?>/)?.[0]
                || pXml.match(/<a:defRPr[^>]*\/?>/)?.[0]
                || levelRPr
                || '';

            const align = this.getAttr(pPr, 'algn') || undefined;
            const size = Number(this.getAttr(rPr, 'sz') || 0);
            const color = this.extractColorFromXml(rPr, colors);
            const hasBullet = /<a:buChar\b|<a:buAutoNum\b|<a:buBlip\b/.test(pXml) || /<a:buChar\b|<a:buAutoNum\b|<a:buBlip\b/.test(levelStyle);
            const hasBuNone = /<a:buNone\b/.test(pXml) || /<a:buNone\b/.test(levelStyle);

            paragraphs.push({
                text,
                level: Number.isFinite(level) ? level : 0,
                bullet: hasBullet && !hasBuNone,
                align,
                fontSizePx: size > 0 ? Math.round((size / 100) * 1.333) : undefined,
                bold: this.parseOptionalBoolAttr(rPr, 'b'),
                italic: this.parseOptionalBoolAttr(rPr, 'i'),
                color,
                runs: runs.length > 0 ? runs : undefined
            });
        }

        return paragraphs;
    }

    // -------------------------------------------------------------------
    // Geometry
    // -------------------------------------------------------------------

    static parseGeometry(xml: string): { x: number; y: number; width: number; height: number; rotateDeg?: number; flipH?: boolean; flipV?: boolean } | null {
        const xfrm = this.extractTagBlock(xml, 'a:xfrm') || this.extractTagBlock(xml, 'p:xfrm');
        if (!xfrm) return null;

        const off = xfrm.match(/<a:off[^>]*\/>/)?.[0] || '';
        const ext = xfrm.match(/<a:ext[^>]*\/>/)?.[0] || '';

        const x = Number(this.getAttr(off, 'x') || 0);
        const y = Number(this.getAttr(off, 'y') || 0);
        const cx = Number(this.getAttr(ext, 'cx') || 0);
        const cy = Number(this.getAttr(ext, 'cy') || 0);
        if (!cx && !cy) return null;

        const rotRaw = Number(this.getAttr(xfrm, 'rot') || 0);
        const flipH = this.getAttr(xfrm, 'flipH') === '1';
        const flipV = this.getAttr(xfrm, 'flipV') === '1';

        return {
            x: this.emuToPx(x),
            y: this.emuToPx(y),
            width: this.emuToPx(cx),
            height: this.emuToPx(cy),
            rotateDeg: rotRaw ? rotRaw / 60000 : undefined,
            flipH: flipH || undefined,
            flipV: flipV || undefined
        };
    }

    private static parseGroupTransform(xml: string): Transform {
        const grpPr = this.extractTagBlock(xml, 'p:grpSpPr');
        const xfrm = grpPr ? this.extractTagBlock(grpPr, 'a:xfrm') : '';
        if (!xfrm) return ZERO_TX;

        const off = xfrm.match(/<a:off[^>]*\/>/)?.[0] || '';
        const ext = xfrm.match(/<a:ext[^>]*\/>/)?.[0] || '';
        const chOff = xfrm.match(/<a:chOff[^>]*\/>/)?.[0] || '';
        const chExt = xfrm.match(/<a:chExt[^>]*\/>/)?.[0] || '';

        const offX = Number(this.getAttr(off, 'x') || 0);
        const offY = Number(this.getAttr(off, 'y') || 0);
        const extX = Number(this.getAttr(ext, 'cx') || 1);
        const extY = Number(this.getAttr(ext, 'cy') || 1);
        const chOffX = Number(this.getAttr(chOff, 'x') || 0);
        const chOffY = Number(this.getAttr(chOff, 'y') || 0);
        const chExtX = Number(this.getAttr(chExt, 'cx') || extX || 1);
        const chExtY = Number(this.getAttr(chExt, 'cy') || extY || 1);

        const sx = extX / (chExtX || 1);
        const sy = extY / (chExtY || 1);
        const rotRaw = Number(this.getAttr(xfrm, 'rot') || 0);

        return {
            offX: this.emuToPx(offX - chOffX * sx),
            offY: this.emuToPx(offY - chOffY * sy),
            scaleX: sx,
            scaleY: sy,
            rotDeg: rotRaw ? rotRaw / 60000 : 0
        };
    }

    private static combineTransforms(parent: Transform, child: Transform): Transform {
        return {
            offX: parent.offX + child.offX * parent.scaleX,
            offY: parent.offY + child.offY * parent.scaleY,
            scaleX: parent.scaleX * child.scaleX,
            scaleY: parent.scaleY * child.scaleY,
            rotDeg: (parent.rotDeg || 0) + (child.rotDeg || 0)
        };
    }

    private static applyTransform(
        geom: { x: number; y: number; width: number; height: number; rotateDeg?: number; flipH?: boolean; flipV?: boolean },
        tx: Transform
    ): { x: number; y: number; width: number; height: number; rotateDeg?: number; flipH?: boolean; flipV?: boolean } {
        return {
            x: Math.round(tx.offX + geom.x * tx.scaleX),
            y: Math.round(tx.offY + geom.y * tx.scaleY),
            width: Math.round(geom.width * tx.scaleX),
            height: Math.round(geom.height * tx.scaleY),
            rotateDeg: (geom.rotateDeg || 0) + (tx.rotDeg || 0) || undefined,
            flipH: geom.flipH || undefined,
            flipV: geom.flipV || undefined
        };
    }

    // -------------------------------------------------------------------
    // Theme + colour resolution (default scheme + scheme/srgb only)
    // -------------------------------------------------------------------

    static parseTheme(themeXml: string): ThemeInfo {
        const colors: Record<string, string> = { ...DEFAULT_THEME_COLORS };
        if (!themeXml) return { colors };

        const clrScheme = this.extractTagBlock(themeXml, 'a:clrScheme') || '';
        const keys = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
        for (const key of keys) {
            const block = this.extractTagBlock(clrScheme, `a:${key}`) || '';
            const srgb = block.match(/<a:srgbClr[^>]*val="([^"]+)"/)?.[1];
            const sys = block.match(/<a:sysClr[^>]*lastClr="([^"]+)"/)?.[1];
            if (srgb) colors[key] = `#${srgb.toLowerCase()}`;
            else if (sys) colors[key] = `#${sys.toLowerCase()}`;
        }

        return { colors };
    }

    private static extractBackgroundColor(xml: string, colors: ColorContext): string | undefined {
        if (!xml) return undefined;
        const bgPr = this.extractTagBlock(xml, 'p:bgPr') || '';
        if (!bgPr) return undefined;
        const solid = this.extractColorFromXml(bgPr, colors);
        if (solid) return solid;
        // Background gradFill: fall back to the last stop's colour so the
        // viewer at least matches the gradient's terminal hue. Full gradient
        // backgrounds are not yet wired through to the renderer.
        const gradFill = this.extractTagBlock(bgPr, 'a:gradFill') || '';
        if (gradFill) {
            const stops = gradFill.match(/<a:gs\b[\s\S]*?<\/a:gs>/g) || [];
            const lastStop = stops[stops.length - 1] || gradFill;
            return this.extractColorFromXml(lastStop, colors);
        }
        return undefined;
    }

    /**
     * Invariant (issue #77): `fillColor: undefined` means "no resolved colour"
     * — either `<a:noFill/>` was explicit, or the source had no fill at all.
     * Callers that need to distinguish "transparent on purpose" from "default"
     * should check the renderer fallback (`fillColor` undefined + no
     * `gradientFill` ⇒ transparent). A non-undefined `fillColor` always
     * represents the resolved hex from `<a:solidFill>` (with colour
     * transforms applied).
     */
    private static extractFillColor(xml: string, colors: ColorContext): string | undefined {
        const spPr = this.extractTagBlock(xml, 'p:spPr') || xml;
        const fillScope = this.stripNestedBlocks(spPr, ['a:ln', 'a:effectLst', 'a:scene3d', 'a:sp3d']);
        if (/<a:noFill\b[^>]*\/?>/.test(fillScope)) return undefined;
        const solid = this.extractTagBlock(fillScope, 'a:solidFill') || '';
        return this.extractColorFromXml(solid, colors);
    }

    /**
     * Parse `<a:gradFill>` from a shape's `p:spPr`. Returns the gradient
     * angle in CSS degrees plus a sorted list of stops (`offset` in 0-100,
     * each `color` resolved via the same colour-transform pipeline as
     * `solidFill`). `undefined` when no gradient is present or the stop list
     * is empty. Radial / path gradients (no `<a:lin>`) collapse to `angleDeg: 0`.
     */
    static extractGradientFill(xml: string, colors: ColorContext): PptxGradientFill | undefined {
        const spPr = this.extractTagBlock(xml, 'p:spPr') || xml;
        const fillScope = this.stripNestedBlocks(spPr, ['a:ln', 'a:effectLst', 'a:scene3d', 'a:sp3d']);
        if (/<a:noFill\b[^>]*\/?>/.test(fillScope)) return undefined;
        const gradFill = this.extractTagBlock(fillScope, 'a:gradFill') || '';
        if (!gradFill) return undefined;

        const gsLst = this.extractTagBlock(gradFill, 'a:gsLst') || gradFill;
        const stopMatches = gsLst.match(/<a:gs\b[\s\S]*?<\/a:gs>/g) || [];
        const stops: { offset: number; color: string }[] = [];
        for (const stop of stopMatches) {
            const openTag = stop.match(/<a:gs\b[^>]*>/)?.[0] || '';
            const rawPos = Number(this.getAttr(openTag, 'pos') || 0);
            const offset = Number.isFinite(rawPos) ? Math.max(0, Math.min(100, rawPos / 1000)) : 0;
            const color = this.extractColorFromXml(stop, colors);
            if (!color) continue;
            stops.push({ offset, color });
        }
        if (stops.length === 0) return undefined;
        stops.sort((a, b) => a.offset - b.offset);
        if (stops.length === 1) stops.push({ offset: 100, color: stops[0].color });

        // OOXML <a:lin ang="..."/> stores the angle as 60000ths of a degree,
        // measured clockwise from 3 o'clock (east). CSS linear-gradient angles
        // are measured clockwise from 12 o'clock (north, "to top"), so we
        // rotate by +90° to align the two conventions.
        const linTag = gradFill.match(/<a:lin\b[^>]*\/?>/)?.[0] || '';
        const rawAng = Number(this.getAttr(linTag, 'ang') || 0);
        const ooxmlDeg = Number.isFinite(rawAng) ? rawAng / 60000 : 0;
        const angleDeg = ((ooxmlDeg + 90) % 360 + 360) % 360;

        return { angleDeg, stops };
    }

    private static extractLineColor(xml: string, colors: ColorContext): string | undefined {
        const spPr = this.extractTagBlock(xml, 'p:spPr') || xml;
        const ln = this.extractTagBlock(spPr, 'a:ln') || '';
        if (!ln) return undefined;
        // Respect <a:noFill/> inside <a:ln>: an explicit noFill means "noLine"
        // for our purposes (transparent stroke); we return undefined so the
        // renderer skips painting a border.
        if (/<a:noFill\b[^>]*\/?>/.test(ln)) return undefined;
        return this.extractColorFromXml(ln, colors);
    }

    /**
     * Parse `<a:prstDash val="…">` from `<a:ln>` (issue #77). The renderer
     * maps the preset name (`'dash'`, `'dot'`, `'dashDot'`, etc.) to a
     * CSS/SVG dash pattern. Returns `undefined` when `<a:ln>` has no
     * `<a:prstDash>` tag — callers treat that as "solid" by default.
     */
    static extractLineDash(xml: string): string | undefined {
        const spPr = this.extractTagBlock(xml, 'p:spPr') || xml;
        const ln = this.extractTagBlock(spPr, 'a:ln') || '';
        if (!ln) return undefined;
        const dashTag = ln.match(/<a:prstDash\b[^>]*\/?>/)?.[0];
        if (!dashTag) return undefined;
        const val = this.getAttr(dashTag, 'val');
        return val || undefined;
    }

    /**
     * Parse `<a:bodyPr anchor="t|ctr|b"/>` from a text-bearing shape
     * (issue #77). The renderer maps the value to a CSS flex justify-content
     * keyword. Returns `undefined` when the source has no explicit anchor;
     * callers fall back to the title=center / body=top approximation.
     */
    static extractBodyAnchor(shapeXml: string): string | undefined {
        const bodyPr = shapeXml.match(/<a:bodyPr\b[^>]*\/?>/)?.[0];
        if (!bodyPr) return undefined;
        const anchor = this.getAttr(bodyPr, 'anchor');
        if (!anchor) return undefined;
        return anchor;
    }

    /**
     * Resolve a `<a:srgbClr>`, `<a:sysClr>`, `<a:prstClr>`, or `<a:schemeClr>`
     * descendant inside `xml` to a `#rrggbb` hex string. Honours OOXML colour
     * transforms (`<a:tint>`, `<a:shade>`, `<a:lumMod>`, `<a:lumOff>`, and
     * `<a:alpha>`) on whichever variant matched. Returns `undefined` when no
     * recognised colour element is present.
     *
     * Implementation note: each branch matches both the self-closing
     * `<a:xClr ... />` form and the open / close `<a:xClr>...children...</a:xClr>`
     * form so that nested transforms travel with the variant they decorate.
     */
    static extractColorFromXml(xml: string, colors: ColorContext): string | undefined {
        if (!xml) return undefined;

        const srgbNode = xml.match(/<a:srgbClr[^>]*val="([^"]+)"[^>]*\/>|<a:srgbClr[^>]*val="([^"]+)"[^>]*>[\s\S]*?<\/a:srgbClr>/);
        if (srgbNode) {
            const raw = srgbNode[1] || srgbNode[2];
            if (raw) return this.applyColorTransforms(`#${raw.toLowerCase()}`, srgbNode[0]);
        }

        const sysNode = xml.match(/<a:sysClr[^>]*lastClr="([^"]+)"[^>]*\/>|<a:sysClr[^>]*lastClr="([^"]+)"[^>]*>[\s\S]*?<\/a:sysClr>/);
        if (sysNode) {
            const raw = sysNode[1] || sysNode[2];
            if (raw) return this.applyColorTransforms(`#${raw.toLowerCase()}`, sysNode[0]);
        }

        const presetNode = xml.match(/<a:prstClr[^>]*val="([^"]+)"[^>]*\/>|<a:prstClr[^>]*val="([^"]+)"[^>]*>[\s\S]*?<\/a:prstClr>/);
        if (presetNode) {
            const preset = (presetNode[1] || presetNode[2] || '').toLowerCase();
            const presetColor = this.mapPresetColorName(preset);
            if (presetColor) return this.applyColorTransforms(presetColor, presetNode[0]);
        }

        const schemeNode = xml.match(/<a:schemeClr[^>]*val="([^"]+)"[^>]*\/>|<a:schemeClr[^>]*val="([^"]+)"[^>]*>[\s\S]*?<\/a:schemeClr>/);
        if (schemeNode) {
            const scheme = ((schemeNode[1] || schemeNode[2]) || '').trim();
            if (scheme) {
                let base = colors.themeColors[scheme];
                if (!base) {
                    const mapped = colors.clrMap[scheme];
                    if (mapped) base = colors.themeColors[mapped];
                }
                if (base) return this.applyColorTransforms(base, schemeNode[0]);
            }
        }
        return undefined;
    }

    /**
     * Map a common OOXML `<a:prstClr val>` preset colour name to a hex string.
     * Returns `undefined` for names we have not mapped (rare in real PPTX —
     * authoring tools nearly always emit explicit `<a:srgbClr>`).
     */
    static mapPresetColorName(name: string): string | undefined {
        const n = (name || '').toLowerCase();
        if (n === 'black') return '#000000';
        if (n === 'white') return '#ffffff';
        if (n === 'red') return '#ff0000';
        if (n === 'blue') return '#0000ff';
        if (n === 'green') return '#008000';
        if (n === 'yellow') return '#ffff00';
        if (n === 'gray' || n === 'grey') return '#808080';
        if (n === 'cyan') return '#00ffff';
        if (n === 'magenta') return '#ff00ff';
        return undefined;
    }

    /**
     * Apply OOXML colour transforms (`<a:tint>`, `<a:shade>`, `<a:lumMod>`,
     * `<a:lumOff>`) to `hex`. Transforms are read from `xml` (typically the
     * matched `<a:schemeClr>` / `<a:srgbClr>` node and its children). The math
     * matches the VSCode reference: shade scales the colour towards black,
     * tint towards white, then lumMod/lumOff scale + shift the channels.
     * Returns the original `hex` when no transforms are present.
     */
    static applyColorTransforms(hex: string, xml: string): string {
        const rgb = this.hexToRgb(hex);
        if (!rgb) return hex;

        const hasShade = /<a:shade\b/.test(xml);
        const hasTint = /<a:tint\b/.test(xml);
        const hasLumMod = /<a:lumMod\b/.test(xml);
        const hasLumOff = /<a:lumOff\b/.test(xml);
        if (!hasShade && !hasTint && !hasLumMod && !hasLumOff) return hex;

        const shade = Number(xml.match(/<a:shade\b[^>]*val="(\d+)"/)?.[1] || 100000) / 100000;
        const tint = Number(xml.match(/<a:tint\b[^>]*val="(\d+)"/)?.[1] || 0) / 100000;
        const lumMod = Number(xml.match(/<a:lumMod\b[^>]*val="(\d+)"/)?.[1] || 100000) / 100000;
        const lumOff = Number(xml.match(/<a:lumOff\b[^>]*val="(\d+)"/)?.[1] || 0) / 100000;

        const apply = (value: number): number => {
            let c = value * shade;
            c = c + (255 - c) * tint;
            c = c * lumMod + 255 * lumOff;
            return Math.max(0, Math.min(255, Math.round(c)));
        };

        return this.rgbToHex(apply(rgb.r), apply(rgb.g), apply(rgb.b));
    }

    static hexToRgb(hex: string): { r: number; g: number; b: number } | null {
        const raw = (hex || '').replace('#', '').trim();
        if (raw.length === 3) {
            const r = parseInt(raw[0] + raw[0], 16);
            const g = parseInt(raw[1] + raw[1], 16);
            const b = parseInt(raw[2] + raw[2], 16);
            if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
            return { r, g, b };
        }
        if (raw.length === 6) {
            const r = parseInt(raw.slice(0, 2), 16);
            const g = parseInt(raw.slice(2, 4), 16);
            const b = parseInt(raw.slice(4, 6), 16);
            if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
            return { r, g, b };
        }
        return null;
    }

    static rgbToHex(r: number, g: number, b: number): string {
        return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    }

    static buildColorContext(
        theme: ThemeInfo,
        masterXml: string,
        layoutXml: string,
        slideXml: string
    ): ColorContext {
        const masterMap = this.parseMasterClrMap(masterXml);
        const layoutOverride = this.parseClrMapOverride(layoutXml);
        const slideOverride = this.parseClrMapOverride(slideXml);

        let clrMap = { ...masterMap };
        if (layoutOverride) clrMap = { ...clrMap, ...layoutOverride };
        if (slideOverride) clrMap = { ...clrMap, ...slideOverride };

        return {
            themeColors: theme.colors,
            clrMap
        };
    }

    private static parseMasterClrMap(masterXml: string): Record<string, string> {
        const clrMapTag = masterXml.match(/<p:clrMap\b[^>]*\/>/)?.[0] || '';
        if (!clrMapTag) return { ...DEFAULT_CLR_MAP };

        const parsed: Record<string, string> = { ...DEFAULT_CLR_MAP };
        for (const key of Object.keys(DEFAULT_CLR_MAP)) {
            const value = this.getAttr(clrMapTag, key);
            if (value) parsed[key] = value;
        }
        return parsed;
    }

    private static parseClrMapOverride(xml: string): Record<string, string> | null {
        if (!xml) return null;
        const clrMapOvr = this.extractTagBlock(xml, 'p:clrMapOvr') || '';
        if (!clrMapOvr || clrMapOvr.includes('<a:masterClrMapping')) return null;
        const overrideTag = clrMapOvr.match(/<a:overrideClrMapping\b[^>]*\/>/)?.[0] || '';
        if (!overrideTag) return null;
        const parsed: Record<string, string> = {};
        for (const key of Object.keys(DEFAULT_CLR_MAP)) {
            const value = this.getAttr(overrideTag, key);
            if (value) parsed[key] = value;
        }
        return Object.keys(parsed).length > 0 ? parsed : null;
    }

    // -------------------------------------------------------------------
    // Placeholder helpers
    // -------------------------------------------------------------------

    static isTitleShape(xml: string): boolean {
        const phType = xml.match(/<p:ph[^>]*type="([^"]+)"/)?.[1] || '';
        if (phType === 'title' || phType === 'ctrTitle') return true;
        const name = xml.match(/<p:cNvPr[^>]*name="([^"]+)"/)?.[1] || '';
        if (/subtitle/i.test(name)) return false;
        return /^title\b/i.test(name) || /title placeholder/i.test(name);
    }

    static getPlaceholderKey(xml: string): string | undefined {
        const ph = xml.match(/<p:ph[^>]*\/>/)?.[0] || xml.match(/<p:ph[^>]*>/)?.[0] || '';
        if (!ph) return undefined;
        const rawIdx = this.getAttr(ph, 'idx') || '0';
        const idx = (rawIdx && rawIdx !== '0' && rawIdx !== '4294967295') ? rawIdx : undefined;
        const type = (this.getAttr(ph, 'type') || 'body').toLowerCase();
        const normalizedType = this.normalizePlaceholderType(type);
        if (normalizedType === 'title' || normalizedType === 'body' || normalizedType === 'sldnum' || normalizedType === 'ftr' || normalizedType === 'dt') {
            return `type:${normalizedType}`;
        }
        if (idx) return `idx:${idx}`;
        return `type:${normalizedType}`;
    }

    private static normalizePlaceholderType(type: string): string {
        if (type === 'title' || type === 'ctrtitle') return 'title';
        if (type === 'subtitle') return 'body';
        if (type === 'sldnum') return 'sldnum';
        if (type === 'body' || type === 'obj' || type === 'content') return 'body';
        return type;
    }

    private static getPlaceholderType(xml: string): string | undefined {
        const ph = xml.match(/<p:ph[^>]*\/>/)?.[0] || xml.match(/<p:ph[^>]*>/)?.[0] || '';
        if (!ph) return undefined;
        const type = (this.getAttr(ph, 'type') || '').toLowerCase();
        return type || undefined;
    }

    static isPlaceholderPromptText(text: string): boolean {
        const normalized = (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!normalized) return true;
        const promptPatterns = [
            /^click to edit master/i,
            /^click to edit/i,
            /^edit master text styles?$/i,
            /^insert text here$/i,
            /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth) level$/i,
            /^list (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth) level$/i,
            /^click icon to add picture$/i,
            /^마스터 .* 스타일 편집$/i,
            /^마스터 텍스트 스타일을 편집합니다$/i,
            /^(첫째|둘째|셋째|넷째|다섯째|여섯째|일곱째|여덟째|아홉째) 수준$/i
        ];
        return promptPatterns.some((re) => re.test(normalized));
    }

    // -------------------------------------------------------------------
    // Zip / relationship helpers
    // -------------------------------------------------------------------

    private static async getSlideSize(zip: PptxZip): Promise<{ widthPx: number; heightPx: number }> {
        const presentation = await this.readZipText(zip, 'ppt/presentation.xml');
        const szTag = presentation.match(/<p:sldSz[^>]*\/>/)?.[0] || '';
        const cx = Number(this.getAttr(szTag, 'cx') || 0);
        const cy = Number(this.getAttr(szTag, 'cy') || 0);
        if (!cx || !cy) return { widthPx: 1280, heightPx: 720 };

        const widthPx = this.emuToPx(cx);
        const heightPx = this.emuToPx(cy);
        if (widthPx < 300 || heightPx < 200) return { widthPx: 1280, heightPx: 720 };
        return { widthPx, heightPx };
    }

    private static async getOrderedSlidePaths(zip: PptxZip): Promise<string[]> {
        const presentationXml = await this.readZipText(zip, 'ppt/presentation.xml');
        const rels = await this.getRelationships(zip, 'ppt/presentation.xml');

        const relMap = new Map<string, string>();
        rels.forEach((r) => relMap.set(r.id, r.target));

        const ordered: string[] = [];
        const idMatches = presentationXml.match(/<p:sldId[^>]*r:id="([^"]+)"[^>]*\/?/g) || [];
        for (const match of idMatches) {
            const id = match.match(/r:id="([^"]+)"/)?.[1];
            if (!id) continue;
            const target = relMap.get(id);
            if (target && zip.file(target)) ordered.push(target);
        }
        if (ordered.length > 0) return ordered;

        return Object.keys(zip.files)
            .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
            .sort((a, b) => {
                const na = Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0);
                const nb = Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0);
                return na - nb;
            });
    }

    static async getRelationships(zip: PptxZip, partPath: string): Promise<Relationship[]> {
        const relPath = this.toRelsPath(partPath);
        const relXml = await this.readZipText(zip, relPath);
        if (!relXml) return [];

        const list: Relationship[] = [];
        const re = /<Relationship[^>]*Id="([^"]+)"[^>]*Type="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(relXml)) !== null) {
            list.push({
                id: m[1],
                type: m[2],
                target: this.resolvePath(partPath, m[3])
            });
        }
        return list;
    }

    static toRelsPath(partPath: string): string {
        const lastSlash = partPath.lastIndexOf('/');
        const dir = lastSlash === -1 ? '' : partPath.slice(0, lastSlash);
        const base = lastSlash === -1 ? partPath : partPath.slice(lastSlash + 1);
        return dir ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`;
    }

    static resolvePath(basePath: string, target: string): string {
        if (target.startsWith('/')) return target.replace(/^\/+/, '');

        const baseDirIdx = basePath.lastIndexOf('/');
        const baseDir = baseDirIdx === -1 ? '' : basePath.slice(0, baseDirIdx);
        const combined = baseDir ? `${baseDir}/${target}` : target;
        const segments = combined.split('/');
        const stack: string[] = [];
        for (const seg of segments) {
            if (seg === '.' || seg === '') continue;
            if (seg === '..') {
                stack.pop();
            } else {
                stack.push(seg);
            }
        }
        return stack.join('/');
    }

    private static async readZipText(zip: PptxZip, zipPath: string): Promise<string> {
        const file = zip.file(zipPath);
        if (!file) return '';
        return await file.async('text');
    }

    // -------------------------------------------------------------------
    // XML extraction primitives
    // -------------------------------------------------------------------

    static findNextTagIndex(xml: string, tag: string, from: number): number {
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`<${escaped}(?=[\\s>/])`, 'g');
        re.lastIndex = from;
        const m = re.exec(xml);
        return m ? m.index : -1;
    }

    static extractBalancedTag(
        xml: string,
        tag: string,
        startAt: number
    ): { content: string; innerContent: string; end: number } | null {
        const closeToken = `</${tag}>`;

        const firstOpen = this.findNextTagIndex(xml, tag, startAt);
        if (firstOpen !== startAt) return null;

        const firstClose = xml.indexOf('>', firstOpen);
        if (firstClose === -1) return null;

        const beforeClose = xml.slice(firstOpen, firstClose + 1);
        if (/\/\s*>$/.test(beforeClose)) {
            return {
                content: xml.slice(firstOpen, firstClose + 1),
                innerContent: '',
                end: firstClose + 1
            };
        }

        let depth = 1;
        let pos = firstClose + 1;

        while (depth > 0) {
            const nextOpen = this.findNextTagIndex(xml, tag, pos);
            const nextClose = xml.indexOf(closeToken, pos);
            if (nextClose === -1) return null;

            if (nextOpen !== -1 && nextOpen < nextClose) {
                const openEnd = xml.indexOf('>', nextOpen);
                if (openEnd === -1) return null;
                if (xml[openEnd - 1] !== '/') depth += 1;
                pos = openEnd + 1;
            } else {
                depth -= 1;
                pos = nextClose + closeToken.length;
            }
        }

        return {
            content: xml.slice(firstOpen, pos),
            innerContent: xml.slice(firstClose + 1, pos - closeToken.length),
            end: pos
        };
    }

    static extractTagBlock(xml: string, tag: string): string {
        const idx = xml.indexOf(`<${tag}`);
        if (idx === -1) return '';
        return this.extractBalancedTag(xml, tag, idx)?.content || '';
    }

    static getAttr(tag: string, attr: string): string | undefined {
        if (!tag) return undefined;
        const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return tag.match(new RegExp(`${escaped}=(?:"([^"]+)"|'([^']+)')`))?.[1]
            || tag.match(new RegExp(`${escaped}=(?:"([^"]+)"|'([^']+)')`))?.[2];
    }

    private static parseOptionalBoolAttr(tag: string, attr: string): boolean | undefined {
        const raw = this.getAttr(tag, attr);
        if (raw === undefined) return undefined;
        return raw === '1' || raw.toLowerCase() === 'true';
    }

    static emuToPx(emu: number): number {
        return Math.round(emu / 9525);
    }

    static decodeXmlEntities(input: string): string {
        return input
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#xD;/gi, '')
            .replace(/&#xA;/gi, ' ')
            .replace(/&#10;/g, ' ');
    }

    private static extractParagraphLevelStyle(lstStyle: string, level: number): string {
        if (!lstStyle) return '';
        const normalizedLevel = Math.max(0, Math.min(8, Number.isFinite(level) ? level : 0)) + 1;
        return this.extractTagBlock(lstStyle, `a:lvl${normalizedLevel}pPr`) || '';
    }

    private static stripNestedBlocks(xml: string, tags: string[]): string {
        let result = xml;
        for (const tag of tags) {
            const re = new RegExp(`<${tag}\\b[^>]*/>|<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'g');
            result = result.replace(re, '');
        }
        return result;
    }

    static getMimeTypeByExtension(filePath: string): string {
        const dot = filePath.lastIndexOf('.');
        const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase();
        const map: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.bmp': 'image/bmp',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.wmf': 'image/wmf',
            '.emf': 'image/emf'
        };
        return map[ext] || 'application/octet-stream';
    }
}

// ---------------------------------------------------------------------------
// Issue #79 — Browser-safe PPTX fallback text extraction.
//
// When `PptxXmlParser.parseZip` produces a slide tree with zero renderable
// shapes across every slide (e.g. unusual templates, broken exporters, or
// decks whose shape model the parser cannot reconstruct), the viewer drops
// down to this loose-text helper. It walks each `ppt/slides/slideN.xml` and
// concatenates every `<a:t>…</a:t>` payload, mirroring what PowerPoint's
// own "open and repair" recovery shows when nothing else can be rendered.
//
// Design notes:
//   - The helper deliberately bypasses the placeholder cascade, the theme
//     lookup, and the relationships graph — those depend on the same shape
//     tree that already came back empty. We only need the raw text runs,
//     in slide order, so the legacy text-only renderer (`renderLegacySlide`)
//     can show something meaningful.
//   - Output is one string per slide so the caller can plug it directly
//     into a `PptSlideModel`-shaped object (`texts: string[]` with a single
//     joined entry) and reuse the existing fallback dispatch in
//     `pptViewerMain.ts`.
//   - Any IO / decode error is swallowed per-slide; the helper never
//     throws. A slide that yields no text becomes an empty string in the
//     return array.
// ---------------------------------------------------------------------------

const A_T_TAG_RE = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;

/**
 * Walk every slide in the PPTX zip and emit a single joined text string per
 * slide containing every `<a:t>` payload in document order. Empty slides
 * surface as `''` so the caller can keep a 1:1 mapping with the original
 * slide list.
 *
 * Idempotent + side-effect free. Designed to be invoked *after* the primary
 * `PptxXmlParser.parseZip` path returns zero renderable shapes.
 */
export async function extractPptxFallbackText(zip: PptxZip): Promise<string[]> {
    if (!zip || typeof zip.file !== 'function') return [];

    // Slide discovery: prefer the presentation.xml ordering when available
    // (matches the primary parser); fall back to a glob-sort of
    // `ppt/slides/slideN.xml` so we still surface content when the
    // relationships file is malformed.
    const orderedPaths = await discoverSlidePaths(zip);
    if (orderedPaths.length === 0) return [];

    const out: string[] = [];
    for (const slidePath of orderedPaths) {
        try {
            const slideFile = zip.file(slidePath);
            if (!slideFile) {
                out.push('');
                continue;
            }
            const xml = await slideFile.async('text');
            if (!xml) {
                out.push('');
                continue;
            }
            out.push(collectRawTextRuns(xml));
        } catch {
            // best-effort: a single broken slide must not poison the rest.
            out.push('');
        }
    }
    return out;
}

async function discoverSlidePaths(zip: PptxZip): Promise<string[]> {
    // 1) Honour presentation.xml's `<p:sldIdLst>` ordering when possible.
    try {
        const presentationFile = zip.file('ppt/presentation.xml');
        const relsFile = zip.file('ppt/_rels/presentation.xml.rels');
        if (presentationFile && relsFile) {
            const presentationXml = await presentationFile.async('text');
            const relsXml = await relsFile.async('text');
            const relMap = new Map<string, string>();
            const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?/g;
            let m: RegExpExecArray | null;
            while ((m = relRe.exec(relsXml)) !== null) {
                relMap.set(m[1], m[2]);
            }
            const ordered: string[] = [];
            const idMatches = presentationXml.match(/<p:sldId[^>]*r:id="([^"]+)"[^>]*\/?/g) || [];
            for (const match of idMatches) {
                const id = match.match(/r:id="([^"]+)"/)?.[1];
                if (!id) continue;
                const target = relMap.get(id);
                if (!target) continue;
                // Relationship targets in presentation.xml.rels are relative
                // to `ppt/` (e.g. `slides/slide1.xml`); normalise to a
                // zip-rooted path.
                const normalized = target.startsWith('/')
                    ? target.replace(/^\/+/, '')
                    : `ppt/${target.replace(/^\.\/+/, '')}`;
                if (zip.file(normalized)) ordered.push(normalized);
            }
            if (ordered.length > 0) return ordered;
        }
    } catch {
        // best-effort: fall through to the glob path.
    }

    // 2) Fallback: every `ppt/slides/slideN.xml` entry, sorted by N.
    try {
        return Object.keys(zip.files || {})
            .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
            .sort((a, b) => {
                const na = Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0);
                const nb = Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0);
                return na - nb;
            });
    } catch {
        return [];
    }
}

function collectRawTextRuns(slideXml: string): string {
    A_T_TAG_RE.lastIndex = 0;
    const runs: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = A_T_TAG_RE.exec(slideXml)) !== null) {
        const raw = match[1];
        if (typeof raw !== 'string') continue;
        const decoded = decodeXmlEntitiesLoose(raw).replace(/\s+/g, ' ').trim();
        if (decoded.length > 0) runs.push(decoded);
    }
    return runs.join('\n');
}

function decodeXmlEntitiesLoose(input: string): string {
    return input
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&amp;/g, '&');
}

/**
 * Count renderable shapes in a parsed PPTX document. A shape is
 * "renderable" when it produces visible content on the slide:
 *
 *   - `text` shapes with at least one non-empty paragraph,
 *   - `picture` shapes with a resolved `pictureTarget`,
 *   - `table` / `chart` / `diagram` / `shape` shapes (they always render
 *     either content or a placeholder box).
 *
 * Bare `placeholder` shapes are intentionally excluded — they are layout
 * art with no user content. When this count is zero across every slide,
 * the viewer treats the document as "renderable=empty" and dispatches to
 * the loose-text fallback (see `extractPptxFallbackText`).
 */
export function countPptxRenderableShapes(doc: PptxDocument): number {
    if (!doc || !Array.isArray(doc.slides)) return 0;
    let count = 0;
    for (const slide of doc.slides) {
        for (const shape of slide.shapes) {
            if (isRenderableShape(shape)) count += 1;
        }
    }
    return count;
}

function isRenderableShape(shape: PptxShape): boolean {
    switch (shape.kind) {
        case 'text': {
            const paragraphs = shape.paragraphs || [];
            for (const para of paragraphs) {
                const runText = (para.runs || []).map((r) => r.text || '').join('').trim();
                if (runText.length > 0) return true;
                if ((para.text || '').trim().length > 0) return true;
            }
            return false;
        }
        case 'picture':
            return !!shape.pictureTarget;
        case 'table':
        case 'chart':
        case 'diagram':
        case 'shape':
            return true;
        case 'placeholder':
        default:
            return false;
    }
}
