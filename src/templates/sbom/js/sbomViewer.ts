import { mountSbomViewer as mountCoreViewer } from 'omni-viewer-core/viewers/sbom';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountSbomViewer = createChromeCoreViewerMount('sbom', mountCoreViewer);

declare global { interface Window { __omniMountSbom?: typeof mountSbomViewer; } }
if (typeof window !== 'undefined') window.__omniMountSbom = mountSbomViewer;
