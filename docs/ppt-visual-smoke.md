# PPT viewer browser visual smoke harness (design sketch)

This document describes how a future browser-based smoke harness for the PPT
viewer *would* be wired up. It is intentionally a sketch — issue #80
documents the plan; the actual harness ships with whichever follow-up issue
needs it (most likely as part of #79 or #81).

Nothing here is implemented yet. Do not assume any of these scripts or
fixtures exist.

## Goal

The parser unit tests in `src/__tests__/pptxXmlParser.test.ts` and
`src/__tests__/pptBinaryParser.test.ts` cover the data plane. They do not
cover:

- whether the viewer DOM actually mounts,
- whether `<canvas>` / `<img>` elements receive non-blank pixels,
- whether slide-jump and prev / next actually move the viewport,
- whether the legacy `.ppt` text-only path produces a non-empty
  `.slide-frame > .slide-text`.

The smoke harness is the thinnest possible browser-level check for those
four things. It is not a visual diff tool and should not be promoted into
one.

## Non-goals

- Pixel-level diff vs. the VSCode original. That is a manual checklist
  (`docs/ppt-corpus.md` §3) and stays manual.
- Full Playwright / WebDriver suite. Flake budget is tighter than parity
  is worth in CI.
- Cross-browser matrix. Chromium-only; the extension only ships there.

## Shape of the harness

Two layers:

### Layer 1: per-viewer-shell smoke

Load `src/templates/ppt/pptViewer.html?src=<blob URL>` inside a headless
Chromium instance. This is the smallest harness because it does not depend
on the extension's message-passing layer.

```text
playwright.config.ts
test/smoke/ppt.spec.ts
test/smoke/fixtures/pptx/text-only.pptx        # synthetic, < 10 KB
test/smoke/fixtures/pptx/picture-only.pptx
test/smoke/fixtures/ppt/legacy-text-only.ppt   # synthetic, < 10 KB
```

Each spec does:

1. Serve the worktree over `http://localhost:port` (Playwright's built-in
   web server, configured to map `/` to the repo root).
2. Open `/src/templates/ppt/pptViewer.html?src=/test/smoke/fixtures/...`.
3. Wait for the loading element to be hidden.
4. Assert `.pv-stage .pv-slide-host` is present.
5. Assert `.pv-stage .pv-slide-host` has at least one descendant with
   non-zero bounding rect.
6. For the picture fixture, assert there is at least one `<img>` whose
   `naturalWidth > 0`.
7. For the legacy fixture, assert `.slide-frame .slide-text` has
   `textContent.length > 0`.

That's it. Six assertions per fixture. No screenshot diff.

### Layer 2: extension smoke (deferred)

A second pass that loads the unpacked extension via Playwright's
`launchPersistentContext` with the `--load-extension=` flag and drives the
viewer through the same fixtures. Used to catch regressions in the
`viewer.html` → per-viewer shell bridge.

This layer is more expensive and more flake-prone. It belongs in a
manually-triggered workflow, not in the default `npm test` run.

## Fixture sourcing

All synthetic fixtures used by the harness come from
`docs/ppt-corpus.md` §1a. Do **not** invent new fixtures here; reuse the
ones added with the feature issues so that parser tests and smoke tests
share the same artifacts.

## Where this slots into CI

- Default `npm test` continues to run only Jest. Smoke is opt-in.
- A new `npm run smoke` script (when added) runs Playwright against the
  layer-1 specs only.
- CI gating: layer-1 smoke runs on every PR that touches `src/templates/ppt/`
  or `src/utils/ppt*`. Layer-2 runs nightly.

## Why this is documented but not built

The parity matrix and corpus policy (issues #74–#79, #81) need to land
first so the fixtures the smoke harness depends on actually exist. Building
a smoke harness against fixtures that do not exist would either ship empty
specs (no value) or block on speculative fixtures (wrong order).

The implementation owner picks one of:

- bolt this harness onto #81's render-token work, since #81 already
  invalidates the "single slide at a time, easy to smoke" assumption, or
- bolt it onto #79's fallback work, since fallback states are exactly the
  thing parser unit tests cannot observe.

Either is fine. Update this document when the choice is made.
