# PPT viewer parity matrix (Chrome port vs. VSCode original)

This document tracks every PPT capability the VSCode original exposes and the
state of the Chrome port for the same capability. It exists so that follow-up
issues (#74, #75, #76, #77, #78, #79, #81) can be measured against a stable
baseline instead of "best memory at PR time."

## Sources of truth

The "current Chrome support" column was verified directly against the source
in this worktree before each row was filled in. Re-verify when this file is
touched.

- PPTX shape model: `src/utils/pptxXmlParser.ts`
  - `PptxShapeKind = 'text' | 'picture' | 'placeholder' | 'table' | 'chart' | 'diagram' | 'shape'`
    — extended by issues #74 (table/chart/diagram) and #75 (shape).
- PPTX rendering: `src/templates/ppt/js/pptSlideRenderer.ts`
  - `renderShape` switches over all seven kinds (see `renderGeometryShape` for `shape`).
- Legacy `.ppt` shape model: `src/utils/pptBinaryTypes.ts`
  - `PptSlideTextModel = { slideNumber, texts: string[] }` (lines 54–61) —
    no bounds, no images, no colours.
- Legacy `.ppt` parser: `src/utils/pptBinaryParser.ts`
- Orchestration: `src/templates/ppt/js/pptViewerMain.ts`
  - After issue #81: dual-mode — `'continuous'` (default for decks at or
    below `CONTINUOUS_MODE_THRESHOLD` = 100 slides) renders every slide
    into a single scroll container as a `<article class="pv-slide"
    data-page="N" data-index="i">`. The dropdown jump uses
    `scrollIntoView({behavior:'instant', block:'start'})` on the
    matching `[data-index=N]`. The render coroutine captures a
    monotonic `renderToken`; mode switch / dispose / deck change
    increments the token and any in-flight render bails on its next
    gate check (top-of-iteration and after each `requestAnimationFrame`
    yield, every 2 slides). Progress is surfaced in the loading band
    as "Rendering slides… (N/total)" via `pptRenderProgress`. A
    30s wall-clock cap (`CONTINUOUS_RENDER_TIMEOUT_MS`) surfaces
    `pptRenderTimeout` and leaves already-painted slides visible.
    `'single'` mode is the historical one-slide path (preserved
    verbatim, including the existing prev/next + dropdown re-render
    + zoom flows) and remains the auto-default above the threshold.
- pdf.js usage is scoped to the PDF viewer (`src/templates/pdf/*`); there is
  no soffice / LibreOffice conversion pipeline anywhere in the Chrome build
  and there cannot be one (Chrome extensions cannot exec native binaries).

Where the matrix says "Yes" for VSCode, it means the corresponding parser /
renderer code is known to exist in the original; this document does not
re-prove that.

## Support legend

- **Yes** — the feature is implemented and exercised by the parser and the
  renderer; visual output matches the original within the documented
  tolerance.
- **Partial** — some sub-aspect is implemented, but a named gap remains
  (called out in the "Notes" column).
- **No** — the feature is intentionally not implemented; the parser drops
  the relevant XML or the renderer skips it.

## PPTX (.pptx) feature matrix

| Feature | Chrome support | VSCode support | Gap-closing issue | Notes |
| --- | --- | --- | --- | --- |
| Text boxes / paragraphs / runs (font size, bold, italic, colour, align, indent level) | Yes | Yes | — | `extractTextParagraphs` in `pptxXmlParser.ts`; runs carry `bold/italic/color/fontSizePx`. Run-level font family is not yet surfaced (renderer applies major/minor theme font based on `isTitle` only, see `pptSlideRenderer.ts` line ~147–151). |
| Placeholder cascade (title / body inheritance) | Partial | Yes | #77 | `pptxXmlParser.ts` merges placeholders along the title-vs-body branch only. Master → layout → slide cascade for other placeholder types (sldNum, dt, ftr, ctrTitle, pic, chart, tbl, …) is not honoured. |
| Picture shape via `<a:blip r:embed="…">` | Yes | Yes | — | `parsePictureShape` resolves the rel target to `ppt/media/...` and the renderer fetches the zip entry as a `blob:` URL. PNG / JPEG / GIF / BMP / WEBP / SVG MIME detection is in `pptxXmlParser.ts` lines ~1143–1151. |
| Image crop (`a:srcRect`) | No | Yes | #76 | No `srcRect` regex anywhere in `pptxXmlParser.ts`. The picture shape carries no `crop` field. |
| EMF / WMF raster fallback | No | Yes | #76 | The MIME map (`pptxXmlParser.ts` lines 1150–1151) declares `image/wmf` and `image/emf`, but browsers do not natively decode them. There is no rasterisation fallback. The renderer simply hands the blob to `<img src>`. |
| Tables (`a:graphicData uri=".../table"`) | Partial | Yes | #74 | `PptxShapeKind` includes `'table'` (issue #74). `parseGraphicFrameBlock` + `extractTableRows` flatten `<a:tr>`/`<a:tc>` into `string[][]`. Renderer emits an HTML `<table>` with header-row styling. Merged cells surface as empty strings in merged-away positions; cell-level fill / font styling and row/col span info are not preserved. |
| Stacked column charts | Partial | Yes | #74 | `chart` is a `PptxShapeKind`. `parseChartData` reads `<c:barChart>` (`grouping="stacked"`, `barDir="col"`) into `{kind, categories, series}`. Canvas 2D renderer draws axes, gridlines, bars, category labels, and a legend. Number formats, secondary axes, per-series colours from `<c:spPr>`, and data labels are not parsed. |
| Line charts | Partial | Yes | #74 | `parseChartData` reads `<c:lineChart>` into `{kind, categories, series}`. Canvas renderer draws polyline + markers + legend. Same simplifications as stacked column (no `formatCode`, no per-series `<c:spPr>` palette override). |
| SmartArt / diagram placeholder | Partial | Yes | #74 | `PptxShapeKind` includes `'diagram'`. The parser preserves geometry and emits a labelled placeholder box; SmartArt layout reconstruction is not attempted. |
| Preset geometry (`a:prstGeom`) | Yes | Yes | — | `parseShapeBlock` reads `<a:prstGeom prst>` into `presetGeom` on a `kind: 'shape'`. Renderer's `presetGeomToSvgPath` covers rect / ellipse / oval / roundRect / triangle / rtTriangle / diamond / parallelogram / trapezoid / leftArrow / rightArrow / upArrow / downArrow / line / straightConnector1; unsupported presets render as a default rectangle fallback. |
| Custom geometry (`a:custGeom`) | Partial | Yes | #75 | `parseCustomGeometryPath` emits an SVG `d=` string supporting `moveTo`, `lnTo`, `cubicBezTo`, `close`. Arcs (`arcTo`) and quadratic beziers (`quadBezTo`) are silently skipped — matches the VSCode reference. |
| Line connector + arrow markers (`p:cxnSp`, `<a:headEnd>`, `<a:tailEnd>`) | Yes | Yes | — | `collectBlocks` now extracts `<p:cxnSp>` into the shape pipeline. Renderer paints an `<svg><line/></svg>` with `<marker>` defs for `triangle`, `arrow`, `stealth`, `diamond`, `oval` (and skips `none`). `flipH` / `flipV` reverse the line endpoints. |
| Theme colour transforms (`tint`, `shade`, `lumMod`, `lumOff`) | Yes | Yes | — | `applyColorTransforms` (`pptxXmlParser.ts`) reads `<a:tint>`, `<a:shade>`, `<a:lumMod>`, `<a:lumOff>` children of `<a:srgbClr>` / `<a:sysClr>` / `<a:prstClr>` / `<a:schemeClr>` and shifts the RGB channels via the VSCode formula. `<a:alpha>` is parsed-aware (preserved in the transform call) but not yet wired through to renderer opacity. |
| Scheme colour lookup + clrMap / clrMapOverride | Yes | Yes | — | `buildColorContext` + `parseMasterClrMap` + `parseClrMapOverride` (`pptxXmlParser.ts` lines ~831–875). |
| Gradient fill (`a:gradFill`) | Partial | Yes | — | `extractGradientFill` (`pptxXmlParser.ts`) parses `<a:gradFill>` with `<a:lin ang=...>` + `<a:gsLst>` into `gradientFill: { angleDeg, stops[] }`. Renderer paints CSS `linear-gradient(...)` on text/placeholder wrappers and an `<svg:linearGradient>` def on `kind: 'shape'`. Radial / path gradients and `<a:tileRect>` variants are still treated as linear (best-effort fall-through). |
| Line width / dash (`a:ln w=`, `a:prstDash`) | Yes | Yes | — | `extractLineWidthPx` surfaces `<a:ln w>` as `borderWidthPx` (EMU / 12700, never negative); `extractLineDash` reads `<a:prstDash val>` into `borderDash`. Renderer maps the dash preset to CSS `border-style` for HTML wrappers and `stroke-dasharray` for SVG paths/lines. Border width now applies to text / placeholder wrappers as well (`applyBorderToWrapper`), not just `kind: 'shape'`. |
| Text vertical anchor (`bodyPr anchor="ctr|b|t"`) | Yes | Yes | — | `extractBodyAnchor` reads the OOXML `<a:bodyPr anchor>` and `renderTextShape` maps it to `flex-start` / `center` / `flex-end`. Falls back to the title=center / body=top approximation only when the source has no explicit anchor. |
| Master / layout cascade beyond title/body | Partial | Yes | #77 | Footer / date / slide number placeholders are still filtered out at master / layout level via `parseShapeBlock` (prompt-text suppression preserved). Issue #77 confirmed the title/body branch is intentional scope; other placeholder types (`sldNum`, `ctrTitle`, `subTitle`, `pic`, `chart`, `tbl`, `dgm`) still do not inherit position/size/style from master or layout — extending that requires a redesigned placeholder-key strategy. |
| Slide rotation / flip (`xfrm rot`, `flipH`, `flipV`) | Yes | Yes | — | `parseGeometry` reads `rot`/`flipH`/`flipV`. `applyTransform` propagates `flipH` / `flipV` through group inheritance and `parseShapeBlock` plumbs them onto every shape kind. The renderer composes `rotate(...)` + `scaleX(-1)` / `scaleY(-1)` in `applyShapePositioning`, so text / picture / shape all mirror consistently. Line connectors instead reverse the line endpoints inside the SVG (matches the VSCode reference). |
| Slide background fill | Partial | Yes | #77 | `extractBackgroundColor` resolves a solid colour from slide → layout → master; gradient backgrounds fall back to the gradient's *last* stop colour (so the page roughly matches the gradient's terminal hue). Full gradient backgrounds are not yet wired through to the renderer. Picture backgrounds still fall back to white. |

## Legacy .ppt (PowerPoint 97-2003) feature matrix

| Feature | Chrome support | VSCode support | Gap-closing issue | Notes |
| --- | --- | --- | --- | --- |
| Text extraction (TextCharsAtom, TextBytesAtom incl. CP949 fallback) | Yes | Yes | — | `pptBinaryParser.ts` walks the record tree and emits `PptSlideTextModel.texts: string[]`. |
| Presentation slide dimensions (DocumentAtom) | Yes | Yes | — | `extractPresentationMetrics` reads `RT_DocumentAtom` (1001) and surfaces `widthPx`/`heightPx` (master-unit and EMU paths). Falls back to 720x540 px when the atom is missing. Issue #78 (Tier 1). |
| Slide ordering (SlideListWithText persist refs) | Partial | Partial | #78 (follow-up) | `extractOrderedSlidePersistRefs` walks `RT_SlideListWithText` (4080) → `RT_SlidePersistAtom` (1011) and reorders RT_Slide containers by `recInstance` match. This is the same heuristic the VSCode reference uses; full `RT_PersistDirectoryAtom` (6002) + `UserEditAtom` chain decoding is still deferred. |
| Shape bounds (OfficeArt SpContainer / ClientAnchor / Anchor) | Partial | Yes | #78 (follow-up) | `extractShapeBoundsFromSpContainer` reads `0xF010 ClientAnchor` (int16 + int32 forms) and `0xF00F Anchor`. Group shape transforms (FSPGR + ChildAnchor cascade) and decorative-shape rendering still deferred. |
| Picture extraction (PNG / JPEG / DIB BLIPs) | Partial | Yes | #78 (follow-up) | `extractPicturesFromStream` scans the Pictures stream for PNG (8-byte sig + IEND walk), JPEG (FFD8FF + segment walk), and DIB ('BM' + header length). Per-slide mapping via `OPT` opid `0x0104` / `0x0186` BLIP id (`extractShapeImageRefFromSpContainer`). EMF / WMF are skipped — the browser cannot decode them. The BStoreEntry `(0xF007)` offset table is not consulted yet; the magic-bytes scan handles the same set of decks. |
| Full slide model (text blocks + pictures placed by bounds) | Partial | Yes | #78 (follow-up) | `PptSlideModel.elements` carries `PptSlideElement[]` (`kind: 'text' \| 'picture'` + raw bounds). The viewer dispatches to `renderLegacyPptSlide` when the model is populated; otherwise it falls back to the text-only `<div class="slide-text">` block. Background colour schemes are supported; decorative master/layout shapes and styled text remain deferred. |
| Outline-vs-shape text reconciliation | Partial | Yes | #78 (follow-up) | `extractSlideElements` attributes text atoms to enclosing SpContainers and surfaces orphans with `bounds: undefined`, but does not de-duplicate against the outline-text mirror that PowerPoint writes into both. |
| Master / layout / theme inheritance | Partial | Yes | #78 (follow-up) | `ColorSchemeAtom` background colours now resolve slide-first with document/master fallback and are rendered by the legacy slide frame. Master decorative elements, placeholder geometry/style inheritance, and text/title colour slots remain deferred. |
| EMF / WMF BLIPs | No | No | — | Browsers cannot decode EMF / WMF. The picture scanner intentionally skips them; documented as a hard limitation. |

## Cross-cutting / orchestration

| Concern | Chrome support | VSCode support | Gap-closing issue | Notes |
| --- | --- | --- | --- | --- |
| Render fallback when PPTX produces no renderable shape | Yes | Yes | — | After `PptxXmlParser.parseZip`, `countPptxRenderableShapes` counts shapes that produce visible content (text with non-empty paragraphs, picture with target, table / chart / diagram / shape — bare placeholders excluded). When the total is 0, the viewer invokes `extractPptxFallbackText(zip)` which walks each `ppt/slides/slideN.xml` and concatenates raw `<a:t>` runs in document order. The recovered per-slide text is routed through the legacy text-only renderer so no new rendering shell was added. |
| Render fallback when `.ppt` parser fails | Yes | Yes | — | The load coroutine in `pptViewerMain.ts` now distinguishes parser-failure (parser threw) from no-renderable (parser succeeded with empty `texts[]` and no `elements[]` across every slide). Both cases invoke `extractLooseTextFromCfb(buffer)` — a defensive scan that reuses `parseCfb` / `parseRecords` / `extractAllTexts` and returns `[]` instead of throwing on corrupt input. Recovered text becomes a single virtual slide so the existing legacy text-only renderer can display it. |
| Specific user-facing error messages | Yes | Yes | — | i18n-keyed messages distinguish three failure classes: `pptFallbackParserFailed` (corrupt / unsupported file), `pptFallbackNoRenderable` (parser succeeded but no content), `pptFallbackBrowserFailed` (JSZip / pdf.js threw). Keys live in `_locales/en/messages.json` + `_locales/ko/messages.json`; `scripts/sync-locales.mjs` mirrors them to the other 66 locales with `[needsTranslation]` markers. |
| pdf.js mode for pre-converted decks | Partial | Yes (via soffice convert) | #79 | `mountPptViewer(file, container, { pdfBytes })` accepts a pre-converted PDF byte stream. When `pdfBytes` is supplied, the viewer switches to `presentation.mode = 'pdf'` and dispatches to `pptPdfModeRenderer.renderPdfSlides`, which shares the existing pdf.js bootstrap via `loadPdfJsLib` (imported from `src/templates/pdf/js/pdfRenderer.ts` — no duplicate vendor bundle, no parallel worker bootstrap). This is a *hook*: nothing in the Chrome build currently produces `pdfBytes`. The default rendering path (`mode = 'xml'`) is unchanged. |
| Local `soffice` / LibreOffice conversion fallback | No (intentional) | Yes | — (out of scope) | Chrome Web Store builds cannot exec native binaries, so the VSCode original's "convert with `soffice`, render the PDF with pdf.js" pipeline has no analogue here. The user-facing fallback message advises converting the deck to PDF externally and opening it with the built-in PDF viewer; auto-conversion via Native Messaging / server upload is intentionally out of scope (privacy / Web Store policy review required). |
| Continuous slide render + scrollIntoView jump | Yes | Yes | — | `pptViewerMain.ts` now supports two render modes (`'single'` / `'continuous'`). Continuous mode appends every slide into the stage as `<article class="pv-slide" data-page data-index>` and the dropdown jump scrolls the target via `scrollIntoView({behavior:'instant', block:'start'})`. PDF-mode pages share the same markup so the dropdown also jumps within the PDF continuous list. Mode auto-selects continuous for decks at or below `CONTINUOUS_MODE_THRESHOLD` (100 slides) and exposes a toolbar toggle for explicit switches. |
| Render token / progress / timeout | Yes | Yes | — | The render coroutine captures a monotonic `renderToken`. Mode switch / dispose / deck change bumps the token; the loop's top-of-iteration and post-`requestAnimationFrame` gates compare against the captured value and bail silently. The loop yields to the browser every 2 slides (matches the VSCode reference). Progress is surfaced as "Rendering slides… (N/total)" via the new `pptRenderProgress` i18n key. A 30s wall-clock cap (`CONTINUOUS_RENDER_TIMEOUT_MS`) stops runaway renders and surfaces `pptRenderTimeout`; already-painted slides remain visible. |
| Zoom ladder (Ctrl/Cmd ±, Ctrl/Cmd 0) | Yes | Yes | — | `pptZoom.ts` + `pptViewerMain.ts` keydown handling. |
| Slide-jump dropdown ("Slide N: <title>") | Yes | Yes | — | `populateSlideSelect` in `pptViewerMain.ts`. |

## Reading the matrix when sizing an issue

1. Open the row for the feature you intend to land.
2. If "Chrome support" is anything other than "Yes," the listed gap-closing
   issue is the right place for the implementation PR.
3. Add a fixture under the category listed in `docs/ppt-corpus.md` for that
   feature so the regression is locked in.
4. After the PR merges, flip "Chrome support" from "No" → "Partial" or
   "Partial" → "Yes" here, and trim the "Notes" column to reflect what
   actually shipped.
