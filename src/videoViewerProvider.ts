// Chrome-side `VideoViewerProvider`.
//
// The VSCode original (`vscode-omni-viewer/src/videoViewerProvider.ts`) is a
// `vscode.CustomReadonlyEditorProvider` glued to `webview.html`,
// `MessageHandler`, and `TemplateUtils`. None of those primitives exist in
// a Chrome MV3 page — the page hosts the viewer in-process and the router
// hands the provider a `File` directly.
//
// What survives the port:
//   - the *concept* of a Provider (an object with `render(file, container)`),
//   - a stable `viewType` constant identical to the VSCode value, so the
//     two codebases stay diff-friendly.
//
// What is dropped:
//   - `vscode.CustomReadonlyEditorProvider` machinery.
//   - `openCustomDocument` / `resolveCustomEditor` lifecycle.
//   - Template rendering via `TemplateUtils.loadTemplate` (the Chrome side
//     ships compiled HTML inside the bundled module — see
//     `src/templates/video/js/videoViewerMain.ts`).
//   - `MessageHandler` postMessage bridge — the Chrome page has no host
//     bridge to log into.
//
// The actual mounting logic lives in
// `src/templates/video/js/videoViewerMain.ts` (`mountVideoViewer`). This
// module wraps that mount function in the `ChromeViewerProvider` shape so
// callers that prefer importing `VideoViewerProvider` (mirroring the VSCode
// shape) get a class.
//
// Routing-wise, the canonical wiring path is the side-effect inside
// `src/templates/video/js/videoViewer.ts` (the webpack entry), which patches
// `VIEWER_REGISTRATIONS` at module load. This class is exported as a
// secondary, explicit handle for callers that don't want to rely on the
// side-effect import.

import { mountVideoViewer, VideoViewerHandle } from './templates/video/js/videoViewerMain';
import type { ChromeViewerProvider } from './viewerProviderUtils';
import type { OmniViewerViewType } from './viewerRegistry';

export class VideoViewerProvider implements ChromeViewerProvider {
    /** Mirrors `vscode-omni-viewer/src/videoViewerProvider.ts` viewType. */
    public static readonly viewType: OmniViewerViewType = 'omni-viewer.videoViewer';

    private handle: VideoViewerHandle | undefined;

    /**
     * Mount the video viewer for `file` into `container`. Replaces any
     * previously-mounted instance owned by this provider.
     */
    public render(file: File, container: HTMLElement): void {
        this.handle?.dispose();
        this.handle = mountVideoViewer(file, container);
    }

    /** Tear the viewer down. Idempotent. */
    public dispose(): void {
        this.handle?.dispose();
        this.handle = undefined;
    }
}
