# PPT viewer corpus & manual visual-parity policy

Companion to `docs/ppt-parity.md`. The parity matrix says *what* the Chrome
port should eventually do; this document defines *how we know it does it*
without taking on a binary fixture maintenance burden or shipping copyrighted
decks in the repo.

## 1. Fixture policy

### 1a. Synthetic, in-repo fixtures (preferred)

Anything that lives in this repository must be either:

- a hand-written XML / zip-stub string built up inside a unit test (see the
  existing patterns in `src/__tests__/pptxXmlParser.test.ts` and
  `src/__tests__/pptBinaryParser.test.ts`), or
- a tiny synthetic `Uint8Array` constructed in-test (legacy `.ppt` records),
  or
- a small generated `.pptx` produced by a checked-in script that takes only
  zero-byte placeholder media. Generation scripts go under
  `scripts/`-style locations when their feature issue lands; do not add them
  speculatively here.

Hard rules for in-repo fixtures:

- No real-world decks, even ones that "feel public." Treat anything you did
  not personally author as copyrighted.
- No vendor logos or trademarked imagery, including in synthetic media. Use
  flat colour rectangles or geometric placeholders.
- No PII in slide text. Use "Alpha", "Beta", "Gamma" placeholder strings.
- Keep each synthetic `.pptx` under 50 KB. If a feature legitimately needs
  more bytes (e.g. an EMF blob), split the fixture across multiple narrow
  files instead of bundling a fat sample.
- Fixtures land **with the feature issue that exercises them**. Issue #80
  (this issue) intentionally does not add fixtures; the parity matrix is the
  deliverable here. The fixture work is distributed across #74, #75, #76,
  #77, #78, and #79.

### 1b. Local-only manual corpus (`~/omni-viewer-corpus-local/`)

Real-world decks (customer samples, decks downloaded from the web with
unclear licensing, decks containing PII) live **outside the repo**. The
convention is a per-developer directory tree:

```
~/omni-viewer-corpus-local/
  pptx/
    table-only/
    chart-stacked-column/
    chart-line/
    smartart/
    crop-srcRect/
    emf-wmf/
    gradient-heavy/
    theme-cascade/
    custom-geometry/
    connector-arrow/
  ppt/
    legacy-text-only/
    legacy-with-pictures/
    legacy-many-edits-reorder/
  fallback/
    corrupt-pptx-zip/
    truncated-ppt/
    pptx-no-renderable-shape/
```

Hard rules for the local corpus:

- Never check this tree into git. `.gitignore` already excludes everything
  outside the worktree; do not symlink it in either.
- Never paste real customer slide text into PRs or commit messages. When
  reporting a parity bug, describe the structure ("title placeholder
  inherited from layout 2, 3-column table with merged top row") rather
  than the literal content.
- One sub-folder per parity-matrix row that is not yet "Yes." Each folder
  should hold the smallest deck that exercises the feature plus a short
  `NOTES.txt` describing the expected visual result.
- If a sample is needed to reproduce a customer bug, redact the content
  before it leaves the developer's machine. Prefer a hand-written synthetic
  replica.

### 1c. Sensitive / commercial documents

Out of scope for any automated test. They may be used for one-off manual
verification on the engineer's machine; they must never be uploaded to CI
servers, attached to issues, or copied into the worktree.

## 2. Per-feature sample categories

Each bullet corresponds to a parity-matrix row that is currently `No` or
`Partial`. The fixture work belongs to the listed gap-closing issue; this
document only names the category and the minimal shape the sample should
have so that reviewers of the feature PR can sanity-check coverage.

PPTX:

- **table-only deck** (#74) — one slide, one `graphicFrame` containing
  `a:tbl` with 3×3 cells, mixed cell fills, one merged cell.
- **stacked-column chart deck** (#74) — one slide, one chart referencing
  a stacked column `c:barChart` with two series of three categories.
- **line chart deck** (#74) — one slide, one `c:lineChart` with two
  series, including one negative-value series.
- **SmartArt placeholder deck** (#74) — one slide with a `diagram` part;
  acceptable Chrome-side result is a labelled placeholder rectangle until
  full SmartArt lands.
- **picture-with-crop deck** (#76) — one slide with one picture using
  `<a:srcRect l="20000" t="10000" r="20000" b="10000"/>`.
- **EMF / WMF deck** (#76) — one slide referencing an embedded EMF and a
  separate slide referencing a WMF; acceptable degraded result is a
  placeholder rectangle plus a "vector image not supported" badge.
- **preset-geometry deck** (#75) — one slide with prstGeom rectangles,
  ellipses, right triangles, and rounded rectangles, each with a distinct
  fill colour.
- **custom-geometry deck** (#75) — one slide with one `custGeom` shape
  built from `<a:moveTo>`, `<a:lnTo>`, `<a:cubicBezTo>`.
- **connector-with-arrow deck** (#75) — two `prstGeom` boxes joined by a
  `p:cxnSp` straight connector that has both head and tail arrow markers.
- **theme-cascade deck** (#77) — one master, two layouts, two slides; one
  slide overrides clrMap and the other inherits. Includes a shape whose
  fill uses `<a:schemeClr val="accent1"><a:lumMod val="60000"/></a:schemeClr>`
  to exercise tint / shade / lumMod.
- **gradient-heavy deck** (#77) — one slide with a linear gradient
  background, one shape with a `<a:gradFill>` and three colour stops.
- **line-width / dash deck** (#77) — one slide containing rectangles with
  `<a:ln w="38100">` and a `<a:prstDash val="dash"/>`.
- **vertical-anchor deck** (#77) — three text boxes with
  `<a:bodyPr anchor="t"/>`, `anchor="ctr"`, `anchor="b"`.
- **placeholder-cascade beyond title/body deck** (#77) — one master with
  styled `sldNum`, `dt`, `ftr` placeholders, one layout that adds a
  `pic` placeholder, one slide that fills in the `pic` placeholder only.

Legacy `.ppt`:

- **legacy text-only deck** (#78) — the smallest hand-edited
  PowerPoint 97-2003 file we can produce.
- **legacy deck with pictures** (#78) — must include at least one PNG and
  one JPEG BLIP.
- **legacy many-edits deck** (#78) — a deck saved, edited, slides
  reordered, and saved again so PersistDirectoryAtom ordering does not
  match on-disk record order. Used to verify slide ordering.

Fallback:

- **corrupt-pptx-zip deck** (#79) — bytes that look like a zip but cannot
  be opened; expected result is a localised "failed to load PowerPoint"
  message.
- **truncated-ppt deck** (#79) — a legacy `.ppt` cut off mid-record.
- **pptx-no-renderable-shape deck** (#79) — a `.pptx` that parses but
  produces zero shapes (all SmartArt today). Expected result is a
  not-blank fallback message rather than a silent white rectangle.

Note: this project is a Chrome extension. `soffice` (LibreOffice) PDF
conversion is **not available** at runtime — there is no native-process
escape hatch in Chrome's extension sandbox. None of the corpus categories
above assume that fallback exists. The "pre-converted PDF" mode listed in
the parity matrix is therefore documented as a permanent limitation
relative to the VSCode original (see `docs/ppt-parity.md`, row "pdf.js mode
for pre-converted decks").

## 3. Manual VSCode-vs-Chrome visual comparison checklist

Run this checklist against any feature that just landed under #74–#79 or
#81. Open the same deck in:

- **A**: VSCode original (`vscode-omni-viewer`), as the reference.
- **B**: Chrome port (this repo), built with `npm run build` and loaded
  unpacked.

Compare on the same monitor, same OS scaling, same zoom level.

### 3a. Per-feature pass/fail criteria

| Feature | Pass criterion | Fail criterion |
| --- | --- | --- |
| Text boxes / paragraphs / runs | Run-level bold / italic / colour / size match A within 1 px. Line wraps occur within the same word ±1 word. | Different wrap point > 1 word, or a styled run renders as plain text. |
| Picture (blip embed) | Picture is present at the same position and size as in A; aspect ratio identical. | Picture missing, stretched, or at wrong position by > 5 % of slide width. |
| Image crop (`a:srcRect`) | Visible region matches A. The cropped-out region is not visible. | The uncropped full picture renders, or the crop box is offset. |
| EMF / WMF fallback | Either the same raster appears as in A, or a placeholder rectangle with a "vector image" badge appears. | A broken-image icon appears with no badge. |
| Table | Cell grid, cell fills, merged cells, and text alignment match A. | Missing cells, missing borders, or table rendered as plain text. |
| Stacked column chart | Bar count, series colours, stacking order, axis labels match A. Numbers in legend match. | Wrong stacking direction, missing series, or chart rendered as text. |
| Line chart | Line count, colours, marker style, negative-value handling match A. | Missing line, wrong scale (axis cut off), or rendered as text. |
| SmartArt / diagram | Either the diagram or a labelled placeholder appears. | Empty slide where SmartArt should be. |
| Preset geometry | Shape outline matches A (rectangle, ellipse, triangle, …). | Shape rendered as plain rectangle when it should not be. |
| Custom geometry | Outline traces the same path as A within 2 px at 100 % zoom. | Shape missing or renders as bounding rectangle. |
| Connector + arrow | Connector endpoints match A; arrow heads present on the correct ends. | Connector missing or arrow heads absent / on wrong ends. |
| Theme colour transforms | Tint / shade / lumMod produce the same colour as A (eyeball; not a numerical match). | Solid black, solid white, or the un-modified scheme colour shows through. |
| Gradient fill | Gradient direction and colour stops match A. | Solid fill where a gradient is expected. |
| Line width / dash | Stroke width and dash pattern match A. | Hairline solid where a thick dash is expected. |
| Text vertical anchor | Text aligns to top / middle / bottom of the box as in A. | Text always top-aligned regardless of `anchor`. |
| Master / layout cascade | Background, placeholder fonts, and accent shapes from master / layout appear on the slide. | Slide is blank where master / layout should have provided art. |
| Legacy `.ppt` text | All visible text in A appears (any order) in B. | Missing text runs (especially CP949 / Korean). |
| Legacy `.ppt` slide ordering | Slide order matches PowerPoint's display order in A. | Slides re-ordered. |
| Legacy `.ppt` shape / colour / placeholder | Text appears in roughly the same boxes as A (within 50 px). | Text collapsed into one block. |
| Legacy `.ppt` picture extraction | Pictures appear in roughly the same positions as A. | Pictures absent. |
| Fallback when PPTX has no renderable shape | A non-blank "this slide cannot be rendered" message appears. | Silent white rectangle. |
| Fallback when `.ppt` parser fails | A localised error message appears. | Bare exception in console; viewer hangs on "Loading…". |
| Continuous slide render | All slides scroll smoothly; slide-jump dropdown scrolls the target into view. | Only one slide is visible regardless of scroll. |
| Render token / progress / timeout | Switching slides during a slow render does not stack renders; cancellation is visible. | Two renders fight for the stage; progress freezes. |

### 3b. Process

For each comparison run:

1. Pick the deck and the feature row.
2. Open in A, screenshot the slide.
3. Open in B, screenshot the slide.
4. Stack the two screenshots side by side at 100 % zoom.
5. Mark the row pass / fail in the PR description with a one-sentence
   reason.
6. If the row fails, link a follow-up issue from the gap-closing issue
   listed in `docs/ppt-parity.md`. Do not silently weaken the criterion.

### 3c. What is *not* checked

- Animations and transitions. The Chrome port does not implement them and
  there is no current plan to. Do not flag missing animations as parity
  bugs.
- Speaker notes pane. Same reasoning.
- Slide thumbnails / outline strip. Tracked separately; not in
  #74–#79 or #81.
- Print / export. The Chrome port does not export.
