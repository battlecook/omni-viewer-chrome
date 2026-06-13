// Chrome-flavored port of the VSCode Parquet viewer provider concept.
//
// The VSCode original would be a `vscode.CustomReadonlyEditorProvider`
// that owns a `WebviewPanel`, reads the .parquet file from disk, and
// substitutes it into a templated HTML shell. None of that exists in a
// Chrome extension page — the viewer mounts directly into a host element
// inside the SPA, with the `File` provided by the router.
//
// What this module exposes is a thin factory that returns a
// `ChromeViewerProvider`. The actual mount logic lives in
// `src/templates/parquet/js/parquetViewerMain.ts` and is wired into the
// registry by `src/templates/parquet/js/parquetViewer.ts` (the webpack
// entry — see issue #39 self-registration step). This file exists so the
// layout matches the VSCode source one-to-one (each viewer has both a
// `templates/<viewer>/` tree and a top-level `<viewer>ViewerProvider.ts`),
// and so future work (search/sort #40, size guard #41, progressive
// loading #42) has a stable home for any provider-level glue that does
// not belong inside the templates folder.

import type { ChromeViewerProvider } from './viewerProviderUtils';
import {
    mountParquetViewer,
    ParquetViewerHandle,
} from './templates/parquet/js/parquetViewerMain';

export const PARQUET_VIEW_TYPE = 'omni-viewer.parquetViewer' as const;

/**
 * Build a `ChromeViewerProvider` that mounts the real Parquet viewer and
 * forwards `dispose` so the router can release any mount-time resources
 * (currently just the in-flight async parse loop) when the viewer is
 * replaced.
 *
 * The entry (`templates/parquet/js/parquetViewer.ts`) imports the same
 * `mountParquetViewer` and constructs a structurally-identical provider
 * for its registry override. Both routes converge on the same
 * implementation; keeping this top-level factory exported makes future
 * refactors (e.g. moving the registry hook into `viewerRegistry.ts`
 * without touching `templates/`) drop-in.
 */
export function createParquetViewerProvider(): ChromeViewerProvider {
    let handle: ParquetViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountParquetViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        },
    };
}
