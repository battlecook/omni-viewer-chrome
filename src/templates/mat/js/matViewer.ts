import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { mountAutomotiveViewer, type AutomotiveViewerHandle } from '../../automotive/js/automotiveViewerMain';

export async function mountMatViewer(file: File, container: HTMLElement): Promise<AutomotiveViewerHandle> {
    return mountAutomotiveViewer(file, container);
}

function createMatProvider(): ChromeViewerProvider {
    let handle: AutomotiveViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountMatViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

const registration = VIEWER_REGISTRATIONS.find((r) => r.viewType === 'omni-viewer.matViewer');
if (registration) {
    registration.createProvider = createMatProvider;
}
