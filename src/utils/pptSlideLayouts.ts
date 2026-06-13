/**
 * Pure layout / placeholder cascade helpers for the Chrome PPT viewer
 * (issue #47 — refines the rendered output produced by the issue #46 parser).
 *
 * The renderer in `src/templates/ppt/js/pptSlideRenderer.ts` consumes these
 * helpers to make slide rendering closer to PowerPoint without expanding the
 * parser surface (`src/utils/pptxXmlParser.ts` from #46 stays untouched per
 * the issue's guardrails). Everything in here is intentionally:
 *
 *   - pure (no DOM, no zip, no async),
 *   - free of side effects,
 *   - testable in jest without any browser polyfills.
 *
 * Helpers exposed:
 *
 *   - {@link emuToPx} — single canonical EMU → px conversion (1 px = 9525 EMU).
 *   - {@link slideAspectRatio} / {@link inferSlideAspectKind} — aspect ratio
 *     derivation from the parsed `widthPx` × `heightPx` (which the parser
 *     already converts from `<p:sldSz cx cy>`).
 *   - {@link resolveThemeFontFamily} — maps the `+mn-lt` / `+mj-lt` typeface
 *     tokens used by PPTX theme fonts to a CSS font stack with
 *     `system-ui` as the default fallback.
 *   - {@link resolvePlaceholderProps} — placeholder cascade that fills in a
 *     shape that's marked as a placeholder by inheriting position / size /
 *     paragraphs from the layout and master parts (idx / key based match).
 *
 * Deferred (see issue #47 follow-ups):
 *
 *   - gradient / picture fills,
 *   - custGeom path data,
 *   - advanced theme colour transforms (lumMod / lumOff / tint / shade),
 *   - connector arrow head / tail,
 *   - animations / transitions,
 *   - per-run typeface tokens (the parser doesn't surface them yet; this
 *     module's font helper is ready for the day they do).
 */

// ---------------------------------------------------------------------------
// EMU / aspect ratio helpers
// ---------------------------------------------------------------------------

/**
 * 1 EMU = 1/914400 inch. Office uses 96 DPI for screen layout, so 1 px = 9525
 * EMU. The parser already rounds when it writes the public `widthPx` /
 * `heightPx` fields; helpers in this module preserve precision so the math
 * downstream (aspect ratio, scale factors) doesn't accumulate rounding error.
 *
 * The `round` option matches the parser's convention (Math.round) for code
 * paths that want pixel-perfect integer geometry.
 */
export const EMU_PER_PX = 9525;

export interface EmuToPxOptions {
    round?: boolean;
}

export function emuToPx(emu: number, options: EmuToPxOptions = {}): number {
    if (!Number.isFinite(emu)) return 0;
    const px = emu / EMU_PER_PX;
    return options.round ? Math.round(px) : px;
}

export interface SlideSizePx {
    widthPx: number;
    heightPx: number;
}

/**
 * Returns the slide aspect ratio (width / height). Falls back to the
 * 16:9 default when either dimension is non-positive — the renderer treats
 * that as "trust the parser's defaults" rather than crashing the layout.
 */
export function slideAspectRatio(size: SlideSizePx): number {
    const w = Number(size.widthPx);
    const h = Number(size.heightPx);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        return 16 / 9;
    }
    return w / h;
}

export type SlideAspectKind = '16:9' | '4:3' | '16:10' | 'custom';

const ASPECT_TOLERANCE = 0.02;

/**
 * Bucket the parsed slide ratio into one of PowerPoint's three common
 * presets, or `'custom'` when the deck uses an unusual size (e.g. a print
 * template). The renderer uses this only to apply a default frame style;
 * actual frame width / height come from the parsed `widthPx` / `heightPx`.
 */
export function inferSlideAspectKind(size: SlideSizePx): SlideAspectKind {
    const ratio = slideAspectRatio(size);
    if (Math.abs(ratio - 16 / 9) <= ASPECT_TOLERANCE) return '16:9';
    if (Math.abs(ratio - 4 / 3) <= ASPECT_TOLERANCE) return '4:3';
    if (Math.abs(ratio - 16 / 10) <= ASPECT_TOLERANCE) return '16:10';
    return 'custom';
}

// ---------------------------------------------------------------------------
// Theme font fallback
// ---------------------------------------------------------------------------

/**
 * Default CSS font stacks for the two PPTX theme tokens. PowerPoint themes
 * declare a "major" font (used for titles) and a "minor" font (used for body
 * text); when a run references `+mj-lt` / `+mn-lt` we map it to a stack that
 * ends in `system-ui` so the slide stays readable when the original font is
 * not installed on the viewer's machine.
 *
 * The exact head fonts (Calibri Light / Calibri) match the default
 * "Office 2013-2022" theme; decks built from a custom template that
 * declares its own `<a:majorFont>` / `<a:minorFont>` can override these
 * via the optional `theme` argument to {@link resolveThemeFontFamily}.
 */
export const DEFAULT_MAJOR_FONT_STACK = 'Calibri Light, "Segoe UI", Arial, system-ui, sans-serif';
export const DEFAULT_MINOR_FONT_STACK = 'Calibri, "Segoe UI", Arial, system-ui, sans-serif';
export const DEFAULT_FALLBACK_FONT_STACK = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';

export interface ThemeFonts {
    /** Latin major font ("+mj-lt"). Typically used for titles. */
    majorLatin?: string;
    /** Latin minor font ("+mn-lt"). Typically used for body text. */
    minorLatin?: string;
}

/**
 * Resolve the font family for a run. The token is whatever the parser
 * surfaced for the `<a:latin typeface=...>` attribute; in PPTX this is
 * either a literal font name (`"Arial"`) or one of the theme tokens
 * (`+mj-lt` for major, `+mn-lt` for minor).
 *
 * - When `token` is missing, falls back to the major / minor theme stack
 *   based on `isTitle`.
 * - When `token` is a theme token, looks up the explicit theme font and
 *   appends a CSS stack with `system-ui` so the run survives when the
 *   theme font isn't installed.
 * - When `token` is a literal font name, wraps it in a stack (escaping
 *   names that contain whitespace).
 *
 * Always returns a non-empty string so the renderer can assign it directly
 * to `style.fontFamily`.
 */
export function resolveThemeFontFamily(
    token: string | undefined,
    options: { isTitle?: boolean; theme?: ThemeFonts } = {}
): string {
    const theme = options.theme || {};
    const major = theme.majorLatin
        ? wrapFontWithFallback(theme.majorLatin, DEFAULT_MAJOR_FONT_STACK)
        : DEFAULT_MAJOR_FONT_STACK;
    const minor = theme.minorLatin
        ? wrapFontWithFallback(theme.minorLatin, DEFAULT_MINOR_FONT_STACK)
        : DEFAULT_MINOR_FONT_STACK;

    if (!token) {
        return options.isTitle ? major : minor;
    }
    const trimmed = token.trim();
    if (!trimmed) {
        return options.isTitle ? major : minor;
    }
    if (trimmed === '+mj-lt' || trimmed === '+mj-ea' || trimmed === '+mj-cs') {
        return major;
    }
    if (trimmed === '+mn-lt' || trimmed === '+mn-ea' || trimmed === '+mn-cs') {
        return minor;
    }
    return wrapFontWithFallback(trimmed, DEFAULT_FALLBACK_FONT_STACK);
}

function wrapFontWithFallback(family: string, fallbackStack: string): string {
    const trimmed = family.trim();
    if (!trimmed) return fallbackStack;
    const head = /\s/.test(trimmed) && !/^["'].*["']$/.test(trimmed)
        ? `"${trimmed.replace(/"/g, '\\"')}"`
        : trimmed;
    return `${head}, ${fallbackStack}`;
}

// ---------------------------------------------------------------------------
// Placeholder cascade (slide → layout → master)
// ---------------------------------------------------------------------------

/**
 * Subset of `PptxShape` properties we cascade for a placeholder. Kept as an
 * explicit interface (rather than re-exporting from the parser) so this
 * helper module has zero coupling to the parser file — the test fixtures
 * can construct minimal records without recreating the discriminated union.
 */
export interface PlaceholderProps {
    /** Match key — usually `idx:N` or `type:title|body|...`. */
    placeholderKey?: string;
    isTitle?: boolean;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    rotateDeg?: number;
    fillColor?: string;
    borderColor?: string;
    paragraphs?: ReadonlyArray<unknown>;
    pictureTarget?: string;
    pictureMime?: string;
}

/**
 * Resolve the effective props for a placeholder shape by walking the
 * inheritance chain master → layout → slide. The slide level wins for any
 * field it specifies; missing fields fall back to layout, then master.
 *
 * The match strategy is the same as the parser's `getPlaceholderKey`:
 *
 *   1. Prefer the explicit `placeholderKey` (e.g. `type:title`, `idx:1`).
 *   2. When no explicit key is present and the caller asks for a numeric
 *      `idx`, look it up as `idx:<n>`.
 *   3. Title placeholders (`isTitle === true`) match each other across
 *      layers regardless of their idx — that mirrors how PowerPoint's
 *      master title cascades into the layout title.
 *
 * Geometry is only inherited when the slide-level value is missing or
 * non-positive (matches the parser's `hasValidGeometry` rule).
 */
export function resolvePlaceholderProps(
    slide: PlaceholderProps | undefined,
    layout: PlaceholderProps | undefined,
    master: PlaceholderProps | undefined,
    matcher: { idx?: number; key?: string; isTitle?: boolean } = {}
): PlaceholderProps {
    const key = matcher.key
        || (matcher.isTitle ? 'type:title' : undefined)
        || (matcher.idx !== undefined ? `idx:${matcher.idx}` : undefined);

    const candidates: Array<PlaceholderProps | undefined> = [master, layout, slide];
    const matched = candidates.map((c) => matchesPlaceholder(c, key, matcher.isTitle));

    return mergeChain(matched);
}

function matchesPlaceholder(
    candidate: PlaceholderProps | undefined,
    key: string | undefined,
    isTitle: boolean | undefined
): PlaceholderProps | undefined {
    if (!candidate) return undefined;
    if (isTitle && candidate.isTitle) return candidate;
    if (!key) return candidate.placeholderKey ? undefined : candidate;
    if (candidate.placeholderKey === key) return candidate;
    return undefined;
}

function mergeChain(layers: Array<PlaceholderProps | undefined>): PlaceholderProps {
    const out: PlaceholderProps = {};
    for (const layer of layers) {
        if (!layer) continue;
        if (layer.placeholderKey !== undefined) out.placeholderKey = layer.placeholderKey;
        if (layer.isTitle !== undefined) out.isTitle = layer.isTitle || out.isTitle;
        if (hasPositiveDim(layer.width) && hasPositiveDim(layer.height)) {
            out.x = layer.x;
            out.y = layer.y;
            out.width = layer.width;
            out.height = layer.height;
            if (layer.rotateDeg !== undefined) out.rotateDeg = layer.rotateDeg;
        }
        if (layer.fillColor !== undefined) out.fillColor = layer.fillColor;
        if (layer.borderColor !== undefined) out.borderColor = layer.borderColor;
        if (layer.paragraphs && layer.paragraphs.length > 0) {
            out.paragraphs = layer.paragraphs;
        }
        if (layer.pictureTarget !== undefined) out.pictureTarget = layer.pictureTarget;
        if (layer.pictureMime !== undefined) out.pictureMime = layer.pictureMime;
    }
    return out;
}

function hasPositiveDim(value: number | undefined): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
