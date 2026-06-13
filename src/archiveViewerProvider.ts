// Chrome-side `ArchiveViewerProvider`.
//
// The VSCode original (`vscode-omni-viewer/src/archiveViewerProvider.ts`)
// drives a `vscode.CustomReadonlyEditorProvider` and parses the archive on
// the host (Node) side using `JSZip` / system `tar` / `7z`. None of those
// primitives are available in a Chrome MV3 extension page, so the Chrome
// port:
//
//   - keeps the `viewType` constant in sync with the VSCode value,
//   - skips the openCustomDocument / resolveCustomEditor lifecycle,
//   - delegates rendering to `mountArchiveViewer` in
//     `templates/archive/js/archiveViewerMain.ts`, which spawns the
//     libarchive worker shipped under `vendor/libarchive-worker-bundle.js`.
//
// The canonical wiring path is the side-effect inside
// `templates/archive/js/archiveViewer.ts`, which patches
// `VIEWER_REGISTRATIONS` at module load. This class is exported as a
// secondary, explicit handle for callers that prefer to construct the
// provider directly (mirroring the VSCode shape) without relying on the
// side-effect import.

import { mountArchiveViewer, ArchiveViewerHandle } from './templates/archive/js/archiveViewerMain';
import type { ChromeViewerProvider } from './viewerProviderUtils';
import type { OmniViewerViewType } from './viewerRegistry';

export class ArchiveViewerProvider implements ChromeViewerProvider {
    /** Mirrors `vscode-omni-viewer/src/archiveViewerProvider.ts` viewType. */
    public static readonly viewType: OmniViewerViewType = 'omni-viewer.archiveViewer';

    private handle: ArchiveViewerHandle | undefined;

    /**
     * Mount the archive viewer for `file` into `container`. Replaces any
     * previously-mounted instance owned by this provider.
     */
    public render(file: File, container: HTMLElement): void {
        this.handle?.dispose();
        this.handle = mountArchiveViewer(file, container);
    }

    /** Tear the viewer down. Idempotent. Terminates the libarchive worker. */
    public dispose(): void {
        this.handle?.dispose();
        this.handle = undefined;
    }
}
