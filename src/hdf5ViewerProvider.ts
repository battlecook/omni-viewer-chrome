import type { ChromeViewerProvider } from './viewerProviderUtils';
import {
    mountHdf5Viewer,
    Hdf5ViewerHandle,
} from './templates/hdf5/js/hdf5ViewerMain';

export const HDF5_VIEW_TYPE = 'omni-viewer.hdf5Viewer' as const;

export function createHdf5ViewerProvider(): ChromeViewerProvider {
    let handle: Hdf5ViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountHdf5Viewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        },
    };
}
