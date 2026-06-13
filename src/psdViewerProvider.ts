// Chrome-flavored port of `vscode-omni-viewer/src/psdViewerProvider.ts`.
//
// The VSCode original is a `vscode.CustomReadonlyEditorProvider` that owns
// a `WebviewPanel`, reads the PSD bytes from disk, base64-encodes them,
// and substitutes them into a templated HTML shell. None of that exists
// in a Chrome extension page — the viewer mounts directly into a host
// element inside the SPA, with the `File` provided by the router.
//
// What this module exposes is a thin factory that returns a
// `ChromeViewerProvider`. The actual mount logic lives in
// `src/templates/psd/js/psdViewerMain.ts` and is wired into the registry
// by `src/templates/psd/js/psdViewer.ts` (the webpack entry — see
// issue #50 self-registration step). This file exists so the layout
// matches the VSCode source one-to-one (each viewer has both a
// `templates/<viewer>/` tree and a top-level `<viewer>ViewerProvider.ts`),
// and so the layer-panel / view-modal follow-ups (#51, #52) have a stable
// home for any provider-level glue that does not belong inside the
// templates folder.

import type { ChromeViewerProvider } from './viewerProviderUtils';
import {
    mountPsdViewer,
    PsdViewerHandle
} from './templates/psd/js/psdViewerMain';

export const PSD_VIEW_TYPE = 'omni-viewer.psdViewer' as const;

/**
 * Build a `ChromeViewerProvider` that mounts the real PSD viewer and
 * forwards `dispose` so the router can release ag-psd resources when the
 * viewer is replaced.
 *
 * The entry (`templates/psd/js/psdViewer.ts`) imports an inline copy of
 * this factory via its own `createPsdProvider`. Both routes converge on
 * the same `mountPsdViewer` implementation; keeping this top-level
 * factory exported makes future refactors (e.g. moving the registry hook
 * into `viewerRegistry.ts` without touching `templates/`) drop-in.
 */
export function createPsdViewerProvider(): ChromeViewerProvider {
    let handle: PsdViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountPsdViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}
