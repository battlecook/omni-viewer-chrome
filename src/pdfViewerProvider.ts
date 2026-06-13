// Chrome-flavored port of `vscode-omni-viewer/src/pdfViewerProvider.ts`.
//
// The VSCode original is a `vscode.CustomReadonlyEditorProvider` that owns
// a `WebviewPanel`, reads the PDF file from disk, base64-encodes it, and
// substitutes it into a templated HTML shell. None of that exists in a
// Chrome extension page — the viewer mounts directly into a host element
// inside the SPA, with the `File` provided by the router.
//
// What this module exposes is therefore a thin factory that returns a
// `ChromeViewerProvider`. The actual mount logic lives in
// `src/templates/pdf/js/pdfViewerMain.ts` and is wired into the registry
// by `src/templates/pdf/js/pdfViewer.ts` (the webpack entry — see issue
// #16 self-registration step). This file exists so the layout matches the
// VSCode source one-to-one (each viewer has both a `templates/<viewer>/`
// tree and a top-level `<viewer>ViewerProvider.ts`), and so future issues
// (#17–#23) have a stable home for any provider-level glue that does not
// belong inside the templates folder.
//
// Currently, this provider is functionally equivalent to constructing the
// real provider via `createPdfProvider()` in the entry. We export both the
// factory and the viewType constant so downstream code can identify the
// PDF provider without duplicating string literals.

import type { ChromeViewerProvider } from './viewerProviderUtils';
import {
    mountPdfViewer,
    PdfViewerHandle
} from './templates/pdf/js/pdfViewerMain';

export const PDF_VIEW_TYPE = 'omni-viewer.pdfViewer' as const;

/**
 * Build a `ChromeViewerProvider` that mounts the real PDF viewer and
 * forwards `dispose` so the router can release pdf.js resources when the
 * viewer is replaced.
 *
 * The entry (`templates/pdf/js/pdfViewer.ts`) imports this factory
 * indirectly via its own copy of `createPdfProvider`. Both routes converge
 * on the same `mountPdfViewer` implementation; keeping this top-level
 * factory exported makes future refactors (e.g. moving the registry hook
 * into `viewerRegistry.ts` without touching `templates/`) drop-in.
 */
export function createPdfViewerProvider(): ChromeViewerProvider {
    let handle: PdfViewerHandle | undefined;
    return {
        render(file: File, container: HTMLElement): void {
            handle?.dispose();
            handle = mountPdfViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}
