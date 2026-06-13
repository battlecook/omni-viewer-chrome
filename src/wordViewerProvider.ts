// Chrome-flavored port of `vscode-omni-viewer/src/wordViewerProvider.ts`.
//
// The VSCode original is a `vscode.CustomReadonlyEditorProvider` that
// owns a `WebviewPanel`, reads the document from disk, base64-encodes
// it, and substitutes it into a templated HTML shell. None of that
// exists in a Chrome extension page — the viewer mounts directly into
// a host element inside the SPA, with the `File` provided by the
// router.
//
// What this module exposes is therefore a thin factory that returns a
// `ChromeViewerProvider`. The actual mount logic lives in
// `src/templates/word/js/wordViewerMain.ts` and is wired into the
// registry by `src/templates/word/js/wordViewer.ts` (the webpack
// entry — see issue #43 self-registration step). This file exists so
// the layout matches the VSCode source one-to-one (each viewer has
// both a `templates/<viewer>/` tree and a top-level
// `<viewer>ViewerProvider.ts`), and so future issues (#44 .doc legacy,
// #45 embedded preview) have a stable home for any provider-level glue
// that does not belong inside the templates folder.

import type { ChromeViewerProvider } from './viewerProviderUtils';
import {
    mountWordViewer,
    WordViewerHandle
} from './templates/word/js/wordViewerMain';

export const WORD_VIEW_TYPE = 'omni-viewer.wordViewer' as const;

/**
 * Build a `ChromeViewerProvider` that mounts the real Word viewer and
 * forwards `dispose` so the router can release docx-preview resources
 * when the viewer is replaced.
 *
 * The entry (`templates/word/js/wordViewer.ts`) imports this factory
 * indirectly via its own copy of `createWordProvider`. Both routes
 * converge on the same `mountWordViewer` implementation; keeping this
 * top-level factory exported makes future refactors (e.g. moving the
 * registry hook into `viewerRegistry.ts` without touching `templates/`)
 * drop-in.
 */
export function createWordViewerProvider(): ChromeViewerProvider {
    let handle: WordViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountWordViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}
