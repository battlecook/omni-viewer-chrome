// Chrome-flavored port of the VSCode HWP viewer provider concept.
//
// The VSCode original would be a `vscode.CustomReadonlyEditorProvider`
// that owns a `WebviewPanel`, reads the .hwp file from disk, and
// substitutes it into a templated HTML shell. None of that exists in
// a Chrome extension page — the viewer mounts directly into a host
// element inside the SPA, with the `File` provided by the router.
//
// What this module exposes is therefore a thin factory that returns a
// `ChromeViewerProvider`. The actual mount logic lives in
// `src/templates/hwp/js/hwpViewerMain.ts` and is wired into the
// registry by `src/templates/hwp/js/hwpViewer.ts` (the webpack entry —
// see issue #53 self-registration step). This file exists so the
// layout matches the VSCode source one-to-one (each viewer has both a
// `templates/<viewer>/` tree and a top-level `<viewer>ViewerProvider.ts`),
// and so future work has a stable home for any provider-level glue
// that does not belong inside the templates folder.
//
// Currently this provider is functionally equivalent to constructing
// the real provider via `createHwpProvider()` in the entry. We export
// both the factory and the viewType constant so downstream code can
// identify the HWP provider without duplicating string literals.

import type { ChromeViewerProvider } from './viewerProviderUtils';
import {
    mountHwpViewer,
    HwpViewerHandle,
} from './templates/hwp/js/hwpViewerMain';

export const HWP_VIEW_TYPE = 'omni-viewer.hwpViewer' as const;

/**
 * Build a `ChromeViewerProvider` that mounts the real HWP viewer and
 * forwards `dispose` so the router can release rhwp WASM resources
 * when the viewer is replaced.
 *
 * The entry (`templates/hwp/js/hwpViewer.ts`) imports the same
 * `mountHwpViewer` and constructs a structurally-identical provider
 * for its registry override. Both routes converge on the same
 * implementation; keeping this top-level factory exported makes
 * future refactors (e.g. moving the registry hook into
 * `viewerRegistry.ts` without touching `templates/`) drop-in.
 */
export function createHwpViewerProvider(): ChromeViewerProvider {
    let handle: HwpViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountHwpViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        },
    };
}
