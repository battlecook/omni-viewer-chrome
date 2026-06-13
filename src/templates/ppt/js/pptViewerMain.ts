// Orchestration for the Chrome PPT viewer (issues #46, #47, #48, #49,
// #79, #81).
//
// Wires together:
//   - DOM scaffolding (header + toolbar with prev / next + counter,
//     slide-jump dropdown, and zoom controls — issue #49),
//   - lazy JSZip load from `vendor/jszip.min.js` for `.pptx`,
//   - the .pptx parser (`PptxXmlParser`) which turns the zip into a tree
//     of `Slide` objects,
//   - the .pptx renderer (`renderSlide`) which paints one slide at a
//     time into a `pv-stage` container with a CSS transform that fits
//     the slide to the viewport (the fit scale is multiplied by the
//     user's zoom percent so "100%" still fits the viewport when the
//     deck is wider than the stage — see `applyZoom`),
//   - the legacy `.ppt` (PowerPoint 97-2003) text parser
//     (`PptBinaryParser`, issue #48) which extracts a flat list of text
//     atoms per slide. The legacy path renders each slide as a single
//     `<div class="slide-frame">` containing one `<div class="slide-text">`
//     — no shapes, images, or styling.
//
// Issue #81: continuous render mode. The viewer now supports two slide
// presentation strategies:
//   - `'single'`   — one slide visible at a time, prev/next walks the
//                    `currentIndex` (the historical default).
//   - `'continuous'` — every slide is rendered into the same scroll
//                    container as a `<article class="pv-slide"
//                    data-page="N">`. The dropdown jumps via
//                    `scrollIntoView` and keyboard arrows scroll.
// The default is `'continuous'` for decks at or below
// `CONTINUOUS_MODE_THRESHOLD` (100 slides) and `'single'` above it. A
// toolbar toggle lets the user switch modes manually; the choice is
// session-scoped (see `renderMode`).
//
// Scope (issues #46, #47, #48, #49):
//   - render `.pptx` slides as absolutely-positioned shapes,
//   - shape kinds: text (with run-level styling + bullets), picture
//     (resolved via JSZip blob), placeholder (geometry only),
//   - title placeholder rendered with a larger default font,
//   - one slide visible at a time with prev / next navigation,
//   - slide-jump `<select>` populated with "Slide N: <title>" entries,
//   - 6-step zoom ladder with Ctrl/Cmd+= / Ctrl/Cmd+- / Ctrl/Cmd+0
//     keyboard shortcuts,
//   - legacy `.ppt` text-only fallback (issue #48): per-slide flat text
//     extraction via the binary parser.
//
// Out of scope (deferred to follow-up issues):
//   - charts / tables / SmartArt / custom geometry,
//   - gradient / picture fills, theme colour transforms beyond defaults,
//   - animation / transition support,
//   - thumbnail strip preview,
//   - export to PDF / image,
//   - shapes / images / styling for the legacy `.ppt` path.

import { PPT_VIEWER_CSS } from './pptViewerStyles';
import { loadJsZip } from './pptJsZipLoader';
import {
    renderLegacyPptSlide,
    renderSlide,
    type RenderedSlideHandle
} from './pptSlideRenderer';
import {
    PPT_DEFAULT_ZOOM_PERCENT,
    canZoomIn,
    canZoomOut,
    formatZoomLabel,
    nextZoom,
    percentToScale,
    prevZoom
} from './pptZoom';
import {
    PptxXmlParser,
    countPptxRenderableShapes,
    extractPptxFallbackText,
    type PptxDocument,
    type PptxParagraph,
    type PptxSlide
} from '../../../utils/pptxXmlParser';
import {
    PptBinaryParser,
    extractLooseTextFromCfb
} from '../../../utils/pptBinaryParser';
import type {
    PptParseResult,
    PptSlideModel
} from '../../../utils/pptBinaryTypes';
import { renderPdfSlides, type PdfModeHandle } from './pptPdfModeRenderer';
import { t } from '../../../utils/i18n';

const STYLE_ELEMENT_ID = 'omni-viewer-ppt-styles';

function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = PPT_VIEWER_CSS;
    document.head.appendChild(style);
}

interface PptViewerDom {
    root: HTMLElement;
    title: HTMLElement;
    fileInfo: HTMLElement;
    prevBtn: HTMLButtonElement;
    nextBtn: HTMLButtonElement;
    counter: HTMLElement;
    slideSelect: HTMLSelectElement;
    modeToggleBtn: HTMLButtonElement;
    zoomOutBtn: HTMLButtonElement;
    zoomInBtn: HTMLButtonElement;
    zoomResetBtn: HTMLButtonElement;
    zoomLevel: HTMLElement;
    body: HTMLElement;
    stage: HTMLElement;
    loading: HTMLElement;
    error: HTMLElement;
}

export interface PptViewerHandle {
    dispose(): void;
}

// ---------------------------------------------------------------------------
// Issue #79 — presentation-mode discriminator + fallback dispatch.
//
// `mode = 'xml'` is the default rendering path: parse the deck (`.pptx`
// via `PptxXmlParser`, `.ppt` via `PptBinaryParser`) and render shapes /
// text into the slide stage. `mode = 'pdf'` is a *hook* — when a caller
// supplies pre-converted PDF bytes (via `mountPptViewer(file, container,
// { pdfBytes })`), the viewer dispatches to `renderPdfSlides` and the
// XML / legacy parsers are skipped entirely.
//
// The PDF mode is intentionally NOT a default. Chrome Web Store builds
// cannot run LibreOffice / `soffice`, so the VSCode original's
// "auto-convert on the fly" path has no analogue here. The hook exists
// so that future opt-in features (Native Messaging helper, user-supplied
// PDF, server-side converter) can plug a PDF payload into the same
// viewer shell without a parallel rendering pipeline.
// ---------------------------------------------------------------------------

export type PptPresentationMode = 'xml' | 'pdf';

/**
 * Issue #81 — slide-presentation strategy. `'single'` is the historical
 * one-slide-at-a-time UX; `'continuous'` is the VSCode-parity scroll list.
 * Exposed for tests + the toolbar toggle handler.
 */
export type PptRenderMode = 'single' | 'continuous';

/**
 * Threshold above which the viewer defaults to `'single'` instead of
 * `'continuous'`. 100 slides is chosen because:
 *   - PPTX rendering is shape-heavy (each slide can yield dozens of
 *     `<div>` / `<svg>` nodes), so the DOM cost scales roughly with
 *     slide count;
 *   - the per-shape blob URLs (`renderPictureShape`) live on the heap
 *     until the deck is unloaded, which makes a 200-slide
 *     image-heavy deck a real memory hazard;
 *   - users who explicitly opt in via the toolbar can still flip to
 *     continuous mode for any deck — the threshold only sets the
 *     auto-default.
 * Kept as a top-level constant so tests can read the same number.
 */
export const CONTINUOUS_MODE_THRESHOLD = 100;

/**
 * Wall-clock cap on a continuous render (ms). Matches the VSCode
 * reference's `RENDER_TIMEOUT_MS` order of magnitude. On timeout the
 * loop bails out and surfaces an error; already-painted slides stay
 * visible.
 */
export const CONTINUOUS_RENDER_TIMEOUT_MS = 30_000;

/**
 * Number of slides between forced `requestAnimationFrame` yields in
 * continuous mode. Matches the VSCode reference (yield every 2 slides)
 * so a long deck doesn't block the main thread for the full render.
 */
const CONTINUOUS_RENDER_YIELD_EVERY = 2;

export interface PptMountOptions {
    /** Optional pre-converted PDF bytes — when present, the viewer
     *  short-circuits parsing and renders the PDF directly. */
    pdfBytes?: Uint8Array;
    /**
     * Override the auto-detected render mode. Useful for tests and for
     * callers that want a deterministic mount (e.g. snapshot pages).
     */
    initialRenderMode?: PptRenderMode;
}

/** Specific failure kinds surfaced to the user via i18n-keyed messages. */
type PptErrorKind =
    | 'parserFailure'   // parser threw (corrupt / unsupported file).
    | 'noRenderable'    // parser succeeded but produced nothing renderable
                        // and the loose-text fallback also recovered nothing.
    | 'browserFailure'  // browser-side dep (JSZip, pdf.js) threw before parse.
    | 'renderTimeout';  // continuous render exceeded the wall-clock cap (issue #81).

/**
 * Map a `PptErrorKind` to the chrome.i18n key + the English fallback
 * string used when the runtime is non-extension (jest jsdom) or the key
 * is missing. Centralised here so the dispatch site in the load
 * coroutine stays readable.
 */
function resolvePptErrorMessage(kind: PptErrorKind, detail?: string): string {
    switch (kind) {
        case 'parserFailure':
            return t(
                'pptFallbackParserFailed',
                'Could not read this presentation. The file may be corrupt or saved in an unsupported format. Try converting it to PDF and opening the PDF in this viewer.'
            ) + (detail ? ` (${detail})` : '');
        case 'noRenderable':
            return t(
                'pptFallbackNoRenderable',
                'This presentation has no renderable content (master-only or template-only deck). The viewer could not extract any slide text.'
            );
        case 'browserFailure':
            return t(
                'pptFallbackBrowserFailed',
                'Could not load this presentation in the browser. The unzip / decode step failed; please verify the file is not corrupted.'
            ) + (detail ? ` (${detail})` : '');
        case 'renderTimeout':
            return t(
                'pptRenderTimeout',
                'Rendering took too long and was stopped. Already-rendered slides remain visible.'
            );
    }
}

const VIEWER_HTML = /* html */ `
<div class="pv-container" data-ppt-viewer-root>
    <div class="pv-header">
        <div class="pv-title" data-pv-title></div>
        <div class="pv-file-info" data-pv-file-info></div>
    </div>
    <div class="pv-toolbar">
        <button type="button" id="pv-prev" title="Previous slide">‹ Prev</button>
        <span class="pv-counter" id="pv-counter">– / –</span>
        <button type="button" id="pv-next" title="Next slide">Next ›</button>
        <select id="pv-slideSelect" class="pv-slide-select" title="Jump to slide" disabled></select>
        <button type="button" id="pv-modeToggle" class="pv-text-btn" title="Toggle continuous / single slide mode" disabled>Mode</button>
        <span class="pv-spacer"></span>
        <button type="button" id="pv-zoomOut" class="pv-icon-btn" title="Zoom out (Ctrl/Cmd + -)">−</button>
        <span id="pv-zoomLevel" class="pv-zoom-level">100%</span>
        <button type="button" id="pv-zoomIn" class="pv-icon-btn" title="Zoom in (Ctrl/Cmd + =)">+</button>
        <button type="button" id="pv-zoomReset" class="pv-text-btn" title="Reset zoom (Ctrl/Cmd + 0)">Reset</button>
    </div>
    <div id="pv-loading" class="pv-loading">Loading PowerPoint…</div>
    <div id="pv-error" class="pv-error" style="display: none;"></div>
    <div id="pv-body" class="pv-body" style="display: none;">
        <div id="pv-stage" class="pv-stage"></div>
    </div>
</div>
`;

function resolveDom(container: HTMLElement): PptViewerDom {
    const need = <T extends HTMLElement>(id: string): T => {
        const el = container.querySelector<T>(`#${id}`);
        if (!el) throw new Error(`ppt viewer: missing DOM node #${id}`);
        return el;
    };
    const root = container.querySelector<HTMLElement>('[data-ppt-viewer-root]');
    if (!root) throw new Error('ppt viewer: failed to mount root element');
    const title = root.querySelector<HTMLElement>('[data-pv-title]');
    const fileInfo = root.querySelector<HTMLElement>('[data-pv-file-info]');
    if (!title) throw new Error('ppt viewer: missing title slot');
    if (!fileInfo) throw new Error('ppt viewer: missing file-info slot');
    return {
        root,
        title,
        fileInfo,
        prevBtn: need<HTMLButtonElement>('pv-prev'),
        nextBtn: need<HTMLButtonElement>('pv-next'),
        counter: need('pv-counter'),
        slideSelect: need<HTMLSelectElement>('pv-slideSelect'),
        modeToggleBtn: need<HTMLButtonElement>('pv-modeToggle'),
        zoomOutBtn: need<HTMLButtonElement>('pv-zoomOut'),
        zoomInBtn: need<HTMLButtonElement>('pv-zoomIn'),
        zoomResetBtn: need<HTMLButtonElement>('pv-zoomReset'),
        zoomLevel: need('pv-zoomLevel'),
        body: need('pv-body'),
        stage: need('pv-stage'),
        loading: need('pv-loading'),
        error: need('pv-error')
    };
}

function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Decide which slide-presentation mode a deck should default to. Pulled
 * out of `mountPptViewer` so tests can exercise the threshold rule in
 * isolation. The caller's explicit `initialRenderMode` overrides the
 * automatic decision.
 */
export function pickInitialRenderMode(
    totalSlides: number,
    explicit?: PptRenderMode
): PptRenderMode {
    if (explicit === 'single' || explicit === 'continuous') return explicit;
    if (totalSlides <= 0) return 'single';
    return totalSlides > CONTINUOUS_MODE_THRESHOLD ? 'single' : 'continuous';
}

/**
 * Pull a one-line title from a slide. Prefers the OOXML title-placeholder
 * shape; falls back to the first text shape's first paragraph; falls
 * back to an empty string when no readable text exists. We keep this
 * defensive — the parser doesn't surface a `title` field, so any of
 * these branches can legitimately return nothing on art-heavy decks.
 */
function pickSlideTitle(slide: PptxSlide): string {
    const paragraphsToText = (paras: PptxParagraph[] | undefined): string => {
        if (!paras || paras.length === 0) return '';
        for (const para of paras) {
            const runText = (para.runs || [])
                .map((r) => r.text)
                .join('')
                .trim();
            const text = (runText || para.text || '').trim();
            if (text) return text;
        }
        return '';
    };

    // 1) Explicit title placeholder.
    for (const shape of slide.shapes) {
        if (shape.kind === 'text' && shape.isTitle) {
            const t = paragraphsToText(shape.paragraphs);
            if (t) return t;
        }
    }
    // 2) First text shape with content.
    for (const shape of slide.shapes) {
        if (shape.kind === 'text') {
            const t = paragraphsToText(shape.paragraphs);
            if (t) return t;
        }
    }
    return '';
}

/**
 * Build the "Slide N: <title>" labels used in the dropdown. Centralized
 * so the truncation rule stays consistent (long titles in big decks
 * make the toolbar overflow horizontally otherwise).
 */
function formatSlideOptionLabel(slideNumber: number, title: string): string {
    const cleaned = title.replace(/\s+/g, ' ').trim();
    if (!cleaned) return `Slide ${slideNumber}`;
    const TRUNCATE_AT = 60;
    const truncated = cleaned.length > TRUNCATE_AT
        ? `${cleaned.slice(0, TRUNCATE_AT - 1)}…`
        : cleaned;
    return `Slide ${slideNumber}: ${truncated}`;
}

/**
 * Compute a `transform: scale(...)` that fits the parsed slide pixel size
 * into the available stage size while preserving aspect ratio, and
 * multiply by the user's zoom percent so "100%" still means "fit to
 * viewport". We size the stage div to the scaled dimensions so the
 * surrounding scroll container sees the rendered footprint, not the
 * intrinsic slide size — and so zooming above 100% triggers scroll
 * bars instead of clipping.
 */
function fitSlide(
    stage: HTMLElement,
    host: HTMLElement,
    slide: PptxSlide,
    zoomPercent: number
): void {
    const containerWidth = stage.parentElement?.clientWidth ?? slide.widthPx;
    const padding = 48; // matches body padding * 2
    const availWidth = Math.max(200, containerWidth - padding);
    const fitScale = Math.min(1, availWidth / Math.max(1, slide.widthPx));
    const scale = fitScale * percentToScale(zoomPercent);

    host.style.transform = `scale(${scale})`;
    stage.style.width = `${slide.widthPx * scale}px`;
    stage.style.height = `${slide.heightPx * scale}px`;
}

/**
 * Continuous-mode variant of `fitSlide`: the scale is computed against
 * the *body* width (the scroll container) instead of the stage, and the
 * dimensions are written onto the per-slide `<article>` wrapper rather
 * than the shared stage. The intrinsic frame stays at its parsed pixel
 * size; CSS transform scales it to fit. We do NOT rely on `stage.width`
 * here — every slide computes its own footprint, so wide decks and
 * narrow decks coexist in the same scroll container.
 */
function fitSlideContinuous(
    body: HTMLElement,
    slideArticle: HTMLElement,
    host: HTMLElement,
    slideWidthPx: number,
    slideHeightPx: number,
    zoomPercent: number
): void {
    const padding = 48; // matches body padding * 2
    const availWidth = Math.max(200, body.clientWidth - padding);
    const fitScale = Math.min(1, availWidth / Math.max(1, slideWidthPx));
    const scale = fitScale * percentToScale(zoomPercent);

    host.style.transform = `scale(${scale})`;
    slideArticle.style.width = `${slideWidthPx * scale}px`;
    slideArticle.style.height = `${slideHeightPx * scale}px`;
}

// ---------------------------------------------------------------------------
// Legacy `.ppt` (issue #48) renderer
//
// The legacy path is intentionally minimal: there's no per-shape
// geometry to honour, no images to fetch, no styling to inherit. We
// emit one `<div class="slide-frame">` containing one
// `<div class="slide-text">` per slide and let CSS line-break the
// joined text atoms. The DoD on issue #48 explicitly defers shapes /
// images / styles, so this renderer is *the* viewer for `.ppt` until
// follow-up work expands the binary parser.
// ---------------------------------------------------------------------------

const LEGACY_SLIDE_WIDTH_PX = 960;
const LEGACY_SLIDE_HEIGHT_PX = 720;

/**
 * Pick a one-line title from a legacy slide. The binary parser surfaces
 * a flat `texts: string[]` per slide (no title placeholder distinction
 * available without OfficeArt walking, which is deferred), so we just
 * take the first non-empty entry. Empty falls through to "" and the
 * dropdown formatter renders the bare "Slide N" label.
 */
function pickLegacySlideTitle(slide: PptSlideModel): string {
    for (const text of slide.texts) {
        const cleaned = text.replace(/\s+/g, ' ').trim();
        if (cleaned) return cleaned;
    }
    return '';
}

/** Render one legacy slide as `<div class="slide-frame">` + text. */
function renderLegacySlide(slide: PptSlideModel, host: HTMLElement): void {
    host.innerHTML = '';
    host.classList.add('pv-slide-host');
    host.style.position = 'relative';

    const frame = window.document.createElement('div');
    // Class names match the issue #48 DoD verbatim. We also keep the
    // `.pv-slide-frame` modifier so existing CSS (background, font)
    // applies without duplication.
    frame.className = 'slide-frame pv-slide-frame';
    frame.style.position = 'relative';
    frame.style.width = `${LEGACY_SLIDE_WIDTH_PX}px`;
    frame.style.height = `${LEGACY_SLIDE_HEIGHT_PX}px`;
    frame.style.background = '#ffffff';
    frame.style.overflow = 'auto';
    host.appendChild(frame);

    const text = window.document.createElement('div');
    text.className = 'slide-text pv-slide-text';
    text.style.padding = '32px 48px';
    text.style.fontSize = '18px';
    text.style.lineHeight = '1.5';
    text.style.color = '#000000';
    text.style.whiteSpace = 'pre-wrap';
    text.style.wordBreak = 'break-word';
    text.textContent = slide.texts.join('\n\n');
    frame.appendChild(text);
}

/**
 * Fit-to-viewport math for the legacy renderer. Falls back to a fixed 4:3
 * stage size when the parser did not surface presentation metrics; the
 * full-model path (issue #78) passes the parsed `widthPx` / `heightPx`
 * so the deck's intrinsic aspect ratio is honoured.
 */
function fitLegacySlide(
    stage: HTMLElement,
    host: HTMLElement,
    zoomPercent: number,
    widthPx: number = LEGACY_SLIDE_WIDTH_PX,
    heightPx: number = LEGACY_SLIDE_HEIGHT_PX
): void {
    const containerWidth = stage.parentElement?.clientWidth ?? widthPx;
    const padding = 48;
    const availWidth = Math.max(200, containerWidth - padding);
    const fitScale = Math.min(1, availWidth / Math.max(1, widthPx));
    const scale = fitScale * percentToScale(zoomPercent);

    host.style.transform = `scale(${scale})`;
    stage.style.width = `${widthPx * scale}px`;
    stage.style.height = `${heightPx * scale}px`;
}

/**
 * Treat the user as "typing" when focus is in a form field or
 * contentEditable element. We extend the canonical INPUT/TEXTAREA list
 * with SELECT so changing the slide-jump dropdown via keyboard (e.g.
 * arrow-keys to walk options) doesn't get hijacked into prev/next
 * slide navigation. `isContentEditable` covers rich-text shells.
 */
function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as (HTMLElement & { tagName?: string }) | null;
    if (!el || typeof el.tagName !== 'string') return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if ((el as HTMLElement).isContentEditable === true) return true;
    return false;
}

export function mountPptViewer(
    file: File,
    container: HTMLElement,
    options: PptMountOptions = {}
): PptViewerHandle {
    ensureStylesInjected();
    container.innerHTML = VIEWER_HTML;

    const dom = resolveDom(container);
    dom.title.textContent = file.name;
    dom.fileInfo.textContent = formatFileSize(file.size);
    dom.zoomLevel.textContent = formatZoomLabel(PPT_DEFAULT_ZOOM_PERCENT);

    let disposed = false;
    // Issue #79: presentation mode discriminator. `'xml'` is the default
    // (parse + render shapes); `'pdf'` is the non-default hook used when
    // a caller supplies pre-converted PDF bytes. The XML / legacy parser
    // branches share `currentIndex`, `slideHost`, and the toolbar state;
    // the PDF branch owns its own `pdfModeHandle` and uses the continuous
    // container so the dropdown jump and progress indicator can drive
    // both modes uniformly (issue #81).
    const presentationMode: PptPresentationMode = options.pdfBytes ? 'pdf' : 'xml';
    let pdfModeHandle: PdfModeHandle | undefined;
    let pdfBytesRef: Uint8Array | undefined = options.pdfBytes;
    // Mutually exclusive — only one is populated per session, decided
    // by file extension at load time. The legacy `.ppt` path skips the
    // JSZip + XML parser entirely (no zip, no media files), so we can't
    // reuse the `PptxDocument` shape here.
    let document_: PptxDocument | undefined;
    let legacyDoc: PptParseResult | undefined;
    let currentIndex = 0;
    let zoomPercent = PPT_DEFAULT_ZOOM_PERCENT;
    // Issue #81: in single mode this still holds the in-flight per-slide
    // handle (so prev/next can revoke before the next render). In
    // continuous mode we use `continuousHandles[]` instead.
    let renderedHandle: RenderedSlideHandle | undefined;
    let slideHost: HTMLElement | undefined;
    // Issue #81: render-mode + token state.
    let renderMode: PptRenderMode = 'single';
    /**
     * Per-slide handles in continuous mode. Indexed by `data-index` so
     * the toolbar (dispose, mode switch) can revoke every blob URL the
     * deck created. In `'single'` mode this stays empty.
     */
    const continuousHandles: RenderedSlideHandle[] = [];
    /**
     * Monotonic counter incremented on every render-pipeline initiation
     * (continuous mount, mode switch, dispose, deck switch). Any
     * in-flight render compares its captured token against this value
     * after each `requestAnimationFrame` yield and bails out when they
     * diverge. Exposed to tests via the helper returned alongside the
     * handle (not part of the public mount API — internal state only).
     */
    let renderToken = 0;

    const totalSlides = (): number => {
        if (document_) return document_.totalSlides;
        if (legacyDoc) return legacyDoc.totalSlides;
        if (pdfModeHandle) return pdfModeHandle.numPages;
        return 0;
    };

    const updateCounter = (): void => {
        const total = totalSlides();
        if (total === 0) {
            dom.counter.textContent = '0 / 0';
            dom.prevBtn.disabled = true;
            dom.nextBtn.disabled = true;
            return;
        }
        dom.counter.textContent = `${currentIndex + 1} / ${total}`;
        // Prev/next move the active slide. In continuous mode they
        // scroll the matching `.pv-slide` into view; in single mode
        // they re-render `currentIndex`. Both modes share the
        // edge-disable rule.
        dom.prevBtn.disabled = currentIndex <= 0;
        dom.nextBtn.disabled = currentIndex >= total - 1;
    };

    const populateSlideSelect = (): void => {
        const select = dom.slideSelect;
        select.innerHTML = '';
        const total = totalSlides();
        if (total === 0) {
            select.disabled = true;
            return;
        }
        if (document_) {
            for (let i = 0; i < document_.slides.length; i++) {
                const slide = document_.slides[i];
                const option = window.document.createElement('option');
                option.value = String(i);
                const title = pickSlideTitle(slide);
                option.textContent = formatSlideOptionLabel(slide.slideNumber, title);
                select.appendChild(option);
            }
        } else if (legacyDoc) {
            for (let i = 0; i < legacyDoc.slides.length; i++) {
                const slide = legacyDoc.slides[i];
                const option = window.document.createElement('option');
                option.value = String(i);
                option.textContent = formatSlideOptionLabel(
                    slide.slideNumber,
                    pickLegacySlideTitle(slide)
                );
                select.appendChild(option);
            }
        } else if (pdfModeHandle) {
            // PDF mode has no parsed titles; fall back to "Slide N".
            for (let i = 0; i < pdfModeHandle.numPages; i++) {
                const option = window.document.createElement('option');
                option.value = String(i);
                option.textContent = formatSlideOptionLabel(i + 1, '');
                select.appendChild(option);
            }
        }
        select.disabled = false;
        select.value = String(currentIndex);
    };

    const syncSlideSelect = (): void => {
        if (totalSlides() === 0) return;
        const desired = String(currentIndex);
        if (dom.slideSelect.value !== desired) {
            dom.slideSelect.value = desired;
        }
    };

    /**
     * Refresh the mode-toggle button label + enabled state. Disabled
     * for PDF mode (the user cannot meaningfully switch to single-slide
     * pdf.js paging from the current architecture).
     */
    const updateModeToggle = (): void => {
        if (presentationMode === 'pdf') {
            dom.modeToggleBtn.disabled = true;
            dom.modeToggleBtn.textContent = 'Mode';
            return;
        }
        dom.modeToggleBtn.disabled = totalSlides() === 0;
        dom.modeToggleBtn.textContent = renderMode === 'continuous'
            ? 'Single slide'
            : 'Continuous';
    };

    /**
     * Apply `transform: scale(...)` to every slide in continuous mode
     * at the current zoom. Pure refit (no re-render).
     */
    const refitContinuous = (): void => {
        if (renderMode !== 'continuous') return;
        const slides = dom.stage.querySelectorAll<HTMLElement>('.pv-slide');
        slides.forEach((slideEl) => {
            const host = slideEl.querySelector<HTMLElement>('.pv-slide-host');
            if (!host) return;
            const w = Number(slideEl.dataset.slideWidth);
            const h = Number(slideEl.dataset.slideHeight);
            if (!w || !h) return;
            fitSlideContinuous(dom.body, slideEl, host, w, h, zoomPercent);
        });
    };

    const applyZoom = (): void => {
        dom.zoomLevel.textContent = formatZoomLabel(zoomPercent);
        dom.zoomInBtn.disabled = !canZoomIn(zoomPercent);
        dom.zoomOutBtn.disabled = !canZoomOut(zoomPercent);
        if (renderMode === 'continuous') {
            refitContinuous();
            return;
        }
        if (!slideHost) return;
        if (document_) {
            const slide = document_.slides[currentIndex];
            if (!slide) return;
            fitSlide(dom.stage, slideHost, slide, zoomPercent);
        } else if (legacyDoc) {
            // Issue #78: full-model legacy slides know their intrinsic
            // dimensions; the text-only fallback keeps the fixed 4:3
            // stage size.
            const slide = legacyDoc.slides[currentIndex];
            const useMetrics = slide?.elements && slide.elements.length > 0;
            if (useMetrics) {
                fitLegacySlide(
                    dom.stage,
                    slideHost,
                    zoomPercent,
                    legacyDoc.metrics.widthPx,
                    legacyDoc.metrics.heightPx
                );
            } else {
                fitLegacySlide(dom.stage, slideHost, zoomPercent);
            }
        }
    };

    const renderCurrentPptxSlide = async (): Promise<void> => {
        if (!document_ || disposed) return;
        const slide = document_.slides[currentIndex];
        if (!slide) return;

        renderedHandle?.revoke();
        renderedHandle = undefined;

        slideHost = window.document.createElement('div');
        slideHost.className = 'pv-slide-host';
        dom.stage.innerHTML = '';
        dom.stage.appendChild(slideHost);

        renderedHandle = await renderSlide(document_, slide, slideHost);
        if (disposed) {
            renderedHandle.revoke();
            renderedHandle = undefined;
            return;
        }
        fitSlide(dom.stage, slideHost, slide, zoomPercent);
        updateCounter();
        syncSlideSelect();
    };

    const renderCurrentLegacySlide = (): void => {
        if (!legacyDoc || disposed) return;
        const slide = legacyDoc.slides[currentIndex];
        if (!slide) return;

        renderedHandle?.revoke();
        renderedHandle = undefined;

        slideHost = window.document.createElement('div');
        slideHost.className = 'pv-slide-host';
        dom.stage.innerHTML = '';
        dom.stage.appendChild(slideHost);

        // Issue #78: when the parser surfaced shape-attributed elements,
        // dispatch to the full-model renderer (text blocks placed by
        // their OfficeArt bounds, BLIPs rendered inline). Otherwise the
        // text-only fallback keeps the viewer useful for decks where the
        // OfficeArt walk failed or returned nothing.
        if (slide.elements && slide.elements.length > 0) {
            renderedHandle = renderLegacyPptSlide(
                { slide, metrics: legacyDoc.metrics },
                slideHost
            );
            fitLegacySlide(
                dom.stage,
                slideHost,
                zoomPercent,
                legacyDoc.metrics.widthPx,
                legacyDoc.metrics.heightPx
            );
        } else {
            renderLegacySlide(slide, slideHost);
            fitLegacySlide(dom.stage, slideHost, zoomPercent);
        }
        updateCounter();
        syncSlideSelect();
    };

    const renderCurrentSingleSlide = async (): Promise<void> => {
        if (document_) {
            await renderCurrentPptxSlide();
        } else if (legacyDoc) {
            renderCurrentLegacySlide();
        }
    };

    /**
     * Revoke every per-slide blob URL accumulated during a previous
     * continuous render and clear the stage. Safe to call multiple
     * times (handles drop to length 0). Used before mode switch /
     * dispose / re-render so we don't leak object URLs.
     */
    const teardownContinuous = (): void => {
        for (const h of continuousHandles) {
            try {
                h.revoke();
            } catch {
                // best-effort: revoke() can throw if already revoked.
            }
        }
        continuousHandles.length = 0;
        dom.stage.innerHTML = '';
        delete dom.stage.dataset.mode;
    };

    /**
     * Write the progress indicator into the loading band. Called from
     * the continuous render loop after each slide; the band is shown
     * for the duration of the render and hidden when the loop completes.
     */
    const writeProgress = (current: number, total: number): void => {
        if (disposed) return;
        dom.loading.style.display = 'block';
        dom.loading.textContent = t(
            'pptRenderProgress',
            `Rendering slides… (${current}/${total})`,
            [String(current), String(total)]
        );
    };

    const hideProgress = (): void => {
        dom.loading.style.display = 'none';
        dom.loading.textContent = '';
    };

    /**
     * Yield to the browser so a long render doesn't block the main
     * thread. `requestAnimationFrame` is the matching cadence the VSCode
     * reference uses; we wrap it in a `setTimeout` fallback so jsdom
     * (which has no native rAF) still resolves promptly.
     */
    const yieldToBrowser = (): Promise<void> => {
        return new Promise((resolve) => {
            if (typeof window !== 'undefined'
                && typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(() => resolve());
            } else {
                setTimeout(resolve, 0);
            }
        });
    };

    /**
     * Render every slide into `dom.stage` as a sequence of
     * `<article class="pv-slide" data-page="N" data-index="i">` blocks.
     * Honours the captured `renderToken` so that mode switch / dispose
     * cancels mid-flight, and the wall-clock cap so that a runaway
     * render surfaces an error instead of hanging the tab.
     */
    const renderAllPptxSlidesContinuous = async (myToken: number): Promise<void> => {
        if (!document_) return;
        teardownContinuous();
        dom.stage.dataset.mode = 'continuous';

        const slides = document_.slides;
        const total = slides.length;
        const startedAt = Date.now();

        for (let i = 0; i < total; i++) {
            // Token / dispose / timeout gates. We check at the top of
            // every iteration AND after the yield so an in-flight render
            // bails out as soon as the world changes underneath it.
            if (disposed || myToken !== renderToken) return;
            if (Date.now() - startedAt > CONTINUOUS_RENDER_TIMEOUT_MS) {
                showFailure('renderTimeout');
                return;
            }

            const slide = slides[i];
            const article = window.document.createElement('article');
            article.className = 'pv-slide';
            article.dataset.page = String(slide.slideNumber);
            article.dataset.index = String(i);
            article.dataset.slideWidth = String(slide.widthPx);
            article.dataset.slideHeight = String(slide.heightPx);

            const host = window.document.createElement('div');
            host.className = 'pv-slide-host';
            article.appendChild(host);
            dom.stage.appendChild(article);

            const handle = await renderSlide(document_, slide, host);
            if (disposed || myToken !== renderToken) {
                handle.revoke();
                return;
            }
            continuousHandles.push(handle);
            fitSlideContinuous(dom.body, article, host, slide.widthPx, slide.heightPx, zoomPercent);

            writeProgress(i + 1, total);

            // Yield every N slides — matches the VSCode reference.
            if ((i + 1) % CONTINUOUS_RENDER_YIELD_EVERY === 0 && i + 1 < total) {
                await yieldToBrowser();
                // Re-check after the yield: another render may have been
                // started, in which case we abandon silently. This is
                // the "in-flight render that yields to RAF must observe
                // the token change between yields and bail out" invariant.
                if (disposed || myToken !== renderToken) return;
            }
        }

        hideProgress();
    };

    /**
     * Continuous render path for legacy `.ppt`. Mirrors the .pptx loop
     * but uses `renderLegacyPptSlide` (full-model) or the text-only
     * fallback per slide.
     */
    const renderAllLegacySlidesContinuous = async (myToken: number): Promise<void> => {
        if (!legacyDoc) return;
        teardownContinuous();
        dom.stage.dataset.mode = 'continuous';

        const slides = legacyDoc.slides;
        const total = slides.length;
        const startedAt = Date.now();
        const widthPx = legacyDoc.metrics.widthPx || LEGACY_SLIDE_WIDTH_PX;
        const heightPx = legacyDoc.metrics.heightPx || LEGACY_SLIDE_HEIGHT_PX;

        for (let i = 0; i < total; i++) {
            if (disposed || myToken !== renderToken) return;
            if (Date.now() - startedAt > CONTINUOUS_RENDER_TIMEOUT_MS) {
                showFailure('renderTimeout');
                return;
            }

            const slide = slides[i];
            const article = window.document.createElement('article');
            article.className = 'pv-slide';
            article.dataset.page = String(slide.slideNumber);
            article.dataset.index = String(i);
            article.dataset.slideWidth = String(widthPx);
            article.dataset.slideHeight = String(heightPx);

            const host = window.document.createElement('div');
            host.className = 'pv-slide-host';
            article.appendChild(host);
            dom.stage.appendChild(article);

            if (slide.elements && slide.elements.length > 0) {
                const handle = renderLegacyPptSlide(
                    { slide, metrics: legacyDoc.metrics },
                    host
                );
                continuousHandles.push(handle);
            } else {
                renderLegacySlide(slide, host);
                // Push a no-op revoke so indices line up with slides.
                continuousHandles.push({ revoke: () => undefined });
            }
            fitSlideContinuous(dom.body, article, host, widthPx, heightPx, zoomPercent);

            writeProgress(i + 1, total);

            if ((i + 1) % CONTINUOUS_RENDER_YIELD_EVERY === 0 && i + 1 < total) {
                await yieldToBrowser();
                if (disposed || myToken !== renderToken) return;
            }
        }

        hideProgress();
    };

    /**
     * Initiate a render pass for the current `renderMode`. The render
     * coroutine captures the live `renderToken`; if any subsequent
     * operation (mode switch, dispose, deck change) bumps the token,
     * this coroutine bails on its next gate check.
     */
    const startRender = async (): Promise<void> => {
        const myToken = ++renderToken;
        if (renderMode === 'continuous') {
            if (document_) {
                await renderAllPptxSlidesContinuous(myToken);
            } else if (legacyDoc) {
                await renderAllLegacySlidesContinuous(myToken);
            }
        } else {
            // Single mode — render `currentIndex` only. Clear any
            // continuous DOM state first so the two modes don't clash.
            teardownContinuous();
            await renderCurrentSingleSlide();
        }
        if (!disposed) {
            updateCounter();
            syncSlideSelect();
            updateModeToggle();
        }
    };

    /**
     * Switch render modes at runtime. Bumps the token so any in-flight
     * loop terminates, tears down continuous handles (Blob URL hygiene),
     * and re-renders under the new mode.
     */
    const switchRenderMode = (next: PptRenderMode): void => {
        if (next === renderMode) return;
        renderMode = next;
        updateModeToggle();
        void startRender();
    };

    const goPrev = (): void => {
        const total = totalSlides();
        if (total === 0 || currentIndex <= 0) return;
        currentIndex -= 1;
        if (renderMode === 'continuous') {
            scrollToSlide(currentIndex);
            updateCounter();
            syncSlideSelect();
        } else {
            void startRender();
        }
    };
    const goNext = (): void => {
        const total = totalSlides();
        if (total === 0 || currentIndex >= total - 1) return;
        currentIndex += 1;
        if (renderMode === 'continuous') {
            scrollToSlide(currentIndex);
            updateCounter();
            syncSlideSelect();
        } else {
            void startRender();
        }
    };
    const goTo = (index: number): void => {
        const total = totalSlides();
        if (total === 0) return;
        const clamped = Math.max(0, Math.min(total - 1, Math.floor(index)));
        if (clamped === currentIndex && renderMode === 'single') return;
        currentIndex = clamped;
        if (renderMode === 'continuous') {
            scrollToSlide(currentIndex);
            updateCounter();
            syncSlideSelect();
        } else {
            void startRender();
        }
    };

    /**
     * Continuous-mode dropdown jump. Find the `.pv-slide` whose
     * 1-based `data-page` matches the target slide number and call
     * `scrollIntoView` on it. Falls back to `data-index` when no
     * page-number metadata is set (defensive — every render path
     * stamps `data-page`).
     */
    const scrollToSlide = (index: number): void => {
        const root = dom.stage;
        // Prefer `data-index` (a stable 0-based selector) so we don't
        // depend on the slideNumber field — legacy slides carry it but
        // PDF mode just synthesises 1..N.
        const target = root.querySelector<HTMLElement>(
            `.pv-slide[data-index="${index}"]`
        );
        if (!target) return;
        // `'instant'` keeps the jump snappy; mirrors the VSCode reference.
        // Some browsers / jsdom call `Element.scrollIntoView` without
        // honouring the options bag, but no-arg is also safe.
        try {
            target.scrollIntoView({ behavior: 'instant', block: 'start' });
        } catch {
            target.scrollIntoView();
        }
    };

    const onZoomIn = (): void => {
        const next = nextZoom(zoomPercent);
        if (next === zoomPercent) return;
        zoomPercent = next;
        applyZoom();
        if (renderMode === 'continuous' && presentationMode === 'pdf') {
            // PDF canvases lose crispness on CSS scale; re-rasterise.
            void rerenderPdfAtCurrentZoom();
        }
    };
    const onZoomOut = (): void => {
        const next = prevZoom(zoomPercent);
        if (next === zoomPercent) return;
        zoomPercent = next;
        applyZoom();
        if (renderMode === 'continuous' && presentationMode === 'pdf') {
            void rerenderPdfAtCurrentZoom();
        }
    };
    const onZoomReset = (): void => {
        zoomPercent = PPT_DEFAULT_ZOOM_PERCENT;
        applyZoom();
        if (renderMode === 'continuous' && presentationMode === 'pdf') {
            void rerenderPdfAtCurrentZoom();
        }
    };

    /**
     * Re-rasterise the PDF mode container at the current zoom percent.
     * pdf.js canvases need a fresh `viewport.scale` to stay crisp on
     * zoom — see the VSCode reference, which does the same thing.
     * Known cost: a fresh render pass over every page (matches XML
     * continuous mode's re-render-on-zoom behaviour).
     */
    const rerenderPdfAtCurrentZoom = async (): Promise<void> => {
        if (!pdfBytesRef) return;
        const myToken = ++renderToken;
        pdfModeHandle?.revoke();
        pdfModeHandle = undefined;
        try {
            pdfModeHandle = await renderPdfSlides(pdfBytesRef, dom.stage, {
                isCancelled: () => disposed || myToken !== renderToken,
                onProgress: (cur, tot) => writeProgress(cur, tot),
                scale: percentToScale(zoomPercent)
            });
        } catch {
            // Best-effort: a failed re-render leaves whatever's on screen
            // intact (we tore down the old handle, but the previous
            // canvases still display until the next paint).
        }
        if (!disposed && myToken === renderToken) {
            hideProgress();
            updateCounter();
            syncSlideSelect();
        }
    };

    const onSlideSelectChange = (): void => {
        const idx = Number.parseInt(dom.slideSelect.value, 10);
        if (Number.isNaN(idx)) return;
        goTo(idx);
    };

    const onModeToggleClick = (): void => {
        switchRenderMode(renderMode === 'continuous' ? 'single' : 'continuous');
    };

    const onKeyDown = (e: KeyboardEvent): void => {
        // Skip when the user is typing — matches the convention used by
        // the Word / Image / Audio / PDF viewers.
        if (isEditableTarget(e.target)) return;

        const mod = e.ctrlKey || e.metaKey;
        if (mod) {
            // `e.key` is normalized: '+' for shift+'=' on US layouts,
            // '=' otherwise. Match both so the chord is forgiving.
            if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                onZoomIn();
                return;
            }
            if (e.key === '-' || e.key === '_') {
                e.preventDefault();
                onZoomOut();
                return;
            }
            if (e.key === '0') {
                e.preventDefault();
                onZoomReset();
                return;
            }
            // Other modified keys (Ctrl+R, Ctrl+F, …) fall through to
            // the browser so the page stays usable.
            return;
        }

        // Arrow / PageUp/Down navigation. Same key bindings for both
        // modes — continuous mode scrolls the next slide into view,
        // single mode advances `currentIndex`. We deliberately reuse
        // the existing keyboard handler so the contract from issue #49
        // stays intact.
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
            e.preventDefault();
            goPrev();
        } else if (
            e.key === 'ArrowRight'
            || e.key === 'ArrowDown'
            || e.key === 'PageDown'
            || e.key === ' '
        ) {
            e.preventDefault();
            goNext();
        }
    };

    const onResize = (): void => {
        if (renderMode === 'continuous') {
            refitContinuous();
            return;
        }
        if (!slideHost) return;
        if (document_) {
            const slide = document_.slides[currentIndex];
            if (!slide) return;
            fitSlide(dom.stage, slideHost, slide, zoomPercent);
        } else if (legacyDoc) {
            const slide = legacyDoc.slides[currentIndex];
            const useMetrics = slide?.elements && slide.elements.length > 0;
            if (useMetrics) {
                fitLegacySlide(
                    dom.stage,
                    slideHost,
                    zoomPercent,
                    legacyDoc.metrics.widthPx,
                    legacyDoc.metrics.heightPx
                );
            } else {
                fitLegacySlide(dom.stage, slideHost, zoomPercent);
            }
        }
    };

    dom.prevBtn.addEventListener('click', goPrev);
    dom.nextBtn.addEventListener('click', goNext);
    dom.slideSelect.addEventListener('change', onSlideSelectChange);
    dom.modeToggleBtn.addEventListener('click', onModeToggleClick);
    dom.zoomInBtn.addEventListener('click', onZoomIn);
    dom.zoomOutBtn.addEventListener('click', onZoomOut);
    dom.zoomResetBtn.addEventListener('click', onZoomReset);
    window.document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);

    // Initial zoom button enabled-state (no doc yet, but the buttons
    // are interactive — disabling them only when we hit a ladder edge
    // matches the Word viewer's behaviour during load).
    dom.zoomInBtn.disabled = !canZoomIn(zoomPercent);
    dom.zoomOutBtn.disabled = !canZoomOut(zoomPercent);

    /** Surface a load-time failure with an i18n-keyed user-meaningful message. */
    const showFailure = (kind: PptErrorKind, detail?: string): void => {
        dom.loading.style.display = 'none';
        dom.error.style.display = 'block';
        dom.error.textContent = resolvePptErrorMessage(kind, detail);
    };

    /**
     * Issue #79: PPTX no-renderable-shapes fallback. When the primary
     * parse produced zero renderable shapes across every slide, walk
     * the slide XMLs once more for raw `<a:t>` runs and surface them as
     * a legacy `PptSlideModel[]`. Returns `true` when the fallback was
     * applied (caller should skip the normal pptx render path).
     */
    const tryPptxFallbackText = async (
        parsed: PptxDocument
    ): Promise<boolean> => {
        let perSlideText: string[];
        try {
            perSlideText = await extractPptxFallbackText(parsed.zip);
        } catch {
            perSlideText = [];
        }
        const anyText = perSlideText.some((t) => t.trim().length > 0);
        if (!anyText) return false;

        const fallbackSlides: PptSlideModel[] = perSlideText.map((text, idx) => ({
            slideNumber: idx + 1,
            texts: text.length > 0 ? [text] : []
        }));
        legacyDoc = {
            slides: fallbackSlides,
            totalSlides: fallbackSlides.length,
            metrics: {
                rawWidth: parsed.slides[0]?.widthPx ?? LEGACY_SLIDE_WIDTH_PX,
                rawHeight: parsed.slides[0]?.heightPx ?? LEGACY_SLIDE_HEIGHT_PX,
                widthPx: parsed.slides[0]?.widthPx ?? LEGACY_SLIDE_WIDTH_PX,
                heightPx: parsed.slides[0]?.heightPx ?? LEGACY_SLIDE_HEIGHT_PX
            },
            pictures: new Map()
        };
        // Clear the pptx document so the renderer dispatches via the
        // legacy text-only path. Mode stays `'xml'` — the fallback is
        // not a separate render pipeline.
        document_ = undefined;
        return true;
    };

    /**
     * Issue #79: legacy `.ppt` loose-text recovery. When the primary
     * binary parse returned zero slides OR every slide is text-empty
     * with no `elements[]`, scan the CFB stream for any decodable text
     * atoms and present them as a single virtual slide.
     */
    const tryLegacyLooseTextFallback = async (
        parsed: PptParseResult
    ): Promise<PptParseResult | null> => {
        try {
            const buffer = await file.arrayBuffer();
            const recovered = extractLooseTextFromCfb(buffer);
            const firstSlide = recovered[0];
            if (!firstSlide || firstSlide.length === 0) return null;
            const slide: PptSlideModel = {
                slideNumber: 1,
                texts: firstSlide
            };
            return {
                slides: [slide],
                totalSlides: 1,
                metrics: parsed.metrics,
                pictures: parsed.pictures
            };
        } catch {
            return null;
        }
    };

    /** True when every slide is text-empty AND has no `elements[]`. */
    const legacyResultIsRenderable = (r: PptParseResult): boolean => {
        if (r.totalSlides === 0) return false;
        for (const slide of r.slides) {
            const hasText = (slide.texts || []).some((t) => t.trim().length > 0);
            const hasElements = !!slide.elements && slide.elements.length > 0;
            if (hasText || hasElements) return true;
        }
        return false;
    };

    void (async () => {
        try {
            // Issue #79: pdf.js mode hook (non-default branch). The PPT
            // viewer normally parses + renders shapes; this branch only
            // fires when a caller threads pre-converted PDF bytes through
            // `mountPptViewer(file, container, { pdfBytes })`. Chrome
            // cannot exec LibreOffice / `soffice`, so the producer side
            // is intentionally out of scope here — see `docs/ppt-parity.md`.
            if (presentationMode === 'pdf' && options.pdfBytes) {
                dom.loading.style.display = 'none';
                dom.body.style.display = 'flex';
                dom.stage.innerHTML = '';
                dom.stage.dataset.mode = 'continuous';
                renderMode = 'continuous';
                const myToken = ++renderToken;
                writeProgress(0, 0);
                try {
                    pdfModeHandle = await renderPdfSlides(options.pdfBytes, dom.stage, {
                        isCancelled: () => disposed || myToken !== renderToken,
                        onProgress: (cur, tot) => writeProgress(cur, tot),
                        scale: percentToScale(zoomPercent)
                    });
                } catch (err) {
                    if (disposed) return;
                    const message = err instanceof Error ? err.message : String(err);
                    showFailure('browserFailure', message);
                    return;
                }
                if (disposed || myToken !== renderToken) return;
                hideProgress();
                populateSlideSelect();
                updateCounter();
                updateModeToggle();
                return;
            }

            const lower = file.name.toLowerCase();
            const isLegacyPpt = lower.endsWith('.ppt') && !lower.endsWith('.pptx');

            if (isLegacyPpt) {
                // Legacy `.ppt` (PowerPoint 97-2003) path — issue #48.
                // No JSZip; the binary parser walks the CFB container
                // directly out of the file's `ArrayBuffer`.
                let parsed: PptParseResult;
                try {
                    parsed = await PptBinaryParser.parseFile(file);
                } catch (err) {
                    if (disposed) return;
                    // Parser threw — try the loose-text fallback before
                    // surfacing an error so corrupt-but-text-bearing
                    // decks still show something.
                    const detail = err instanceof Error ? err.message : String(err);
                    const fallback = await tryLegacyLooseTextFallback({
                        slides: [],
                        totalSlides: 0,
                        metrics: {
                            rawWidth: LEGACY_SLIDE_WIDTH_PX,
                            rawHeight: LEGACY_SLIDE_HEIGHT_PX,
                            widthPx: LEGACY_SLIDE_WIDTH_PX,
                            heightPx: LEGACY_SLIDE_HEIGHT_PX
                        },
                        pictures: new Map()
                    });
                    if (fallback && fallback.totalSlides > 0) {
                        legacyDoc = fallback;
                        dom.loading.style.display = 'none';
                        dom.body.style.display = 'flex';
                        currentIndex = 0;
                        renderMode = pickInitialRenderMode(
                            legacyDoc.totalSlides,
                            options.initialRenderMode
                        );
                        populateSlideSelect();
                        await startRender();
                        return;
                    }
                    showFailure('parserFailure', detail);
                    return;
                }
                if (disposed) return;

                if (!legacyResultIsRenderable(parsed)) {
                    // Parser succeeded but nothing renderable — attempt
                    // the loose-text scan before showing the
                    // no-renderable message.
                    const fallback = await tryLegacyLooseTextFallback(parsed);
                    if (fallback && fallback.totalSlides > 0) {
                        legacyDoc = fallback;
                        dom.loading.style.display = 'none';
                        dom.body.style.display = 'flex';
                        currentIndex = 0;
                        renderMode = pickInitialRenderMode(
                            legacyDoc.totalSlides,
                            options.initialRenderMode
                        );
                        populateSlideSelect();
                        await startRender();
                        return;
                    }
                    showFailure('noRenderable');
                    return;
                }

                legacyDoc = parsed;
                dom.loading.style.display = 'none';
                dom.body.style.display = 'flex';
                currentIndex = 0;
                renderMode = pickInitialRenderMode(
                    legacyDoc.totalSlides,
                    options.initialRenderMode
                );
                populateSlideSelect();
                await startRender();
                return;
            }

            // Default modern `.pptx` path.
            const jsZipCtor = await loadJsZip().catch((err) => {
                if (disposed) return null;
                const detail = err instanceof Error ? err.message : String(err);
                showFailure('browserFailure', detail);
                return null;
            });
            if (disposed || !jsZipCtor) return;

            let parsed: PptxDocument;
            try {
                parsed = await PptxXmlParser.parseFile(file, jsZipCtor);
            } catch (err) {
                if (disposed) return;
                const detail = err instanceof Error ? err.message : String(err);
                showFailure('parserFailure', detail);
                return;
            }
            if (disposed) return;

            // Issue #79: renderable-shape gate. The parser may produce
            // a slide tree with zero renderable shapes (template-only
            // decks, exporter quirks). Before showing the "no slides"
            // error, scan the slide XMLs for raw `<a:t>` text runs and
            // route the recovered text through the legacy text-only
            // fallback renderer.
            if (parsed.totalSlides === 0) {
                showFailure('parserFailure');
                return;
            }

            const renderableCount = countPptxRenderableShapes(parsed);
            if (renderableCount === 0) {
                const fellBack = await tryPptxFallbackText(parsed);
                if (!fellBack) {
                    showFailure('noRenderable');
                    return;
                }
                dom.loading.style.display = 'none';
                dom.body.style.display = 'flex';
                currentIndex = 0;
                renderMode = pickInitialRenderMode(
                    legacyDoc?.totalSlides ?? 0,
                    options.initialRenderMode
                );
                populateSlideSelect();
                await startRender();
                return;
            }

            document_ = parsed;
            dom.loading.style.display = 'none';
            dom.body.style.display = 'flex';
            currentIndex = 0;
            renderMode = pickInitialRenderMode(
                document_.totalSlides,
                options.initialRenderMode
            );
            populateSlideSelect();
            await startRender();
        } catch (err) {
            if (disposed) return;
            // Catch-all for unexpected DOM / arithmetic errors — those
            // are most likely browser-side failures (the parser branches
            // already mapped their own errors). Keep the i18n key
            // distinct from parser failure so the user knows the issue
            // is not "this file is corrupt".
            const detail = err instanceof Error ? err.message : String(err);
            showFailure('browserFailure', detail);
        }
    })();

    return {
        dispose(): void {
            disposed = true;
            // Bump the token so any in-flight render loop bails on its
            // next gate check — matches the "abandoned renders compare
            // against the latest token" invariant from issue #81.
            renderToken += 1;
            renderedHandle?.revoke();
            renderedHandle = undefined;
            for (const h of continuousHandles) {
                try {
                    h.revoke();
                } catch {
                    // best-effort
                }
            }
            continuousHandles.length = 0;
            pdfModeHandle?.revoke();
            pdfModeHandle = undefined;
            pdfBytesRef = undefined;
            dom.prevBtn.removeEventListener('click', goPrev);
            dom.nextBtn.removeEventListener('click', goNext);
            dom.slideSelect.removeEventListener('change', onSlideSelectChange);
            dom.modeToggleBtn.removeEventListener('click', onModeToggleClick);
            dom.zoomInBtn.removeEventListener('click', onZoomIn);
            dom.zoomOutBtn.removeEventListener('click', onZoomOut);
            dom.zoomResetBtn.removeEventListener('click', onZoomReset);
            window.document.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', onResize);
        }
    };
}
