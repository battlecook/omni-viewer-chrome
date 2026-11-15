import { mountDrawioViewer as mountCoreViewer } from 'omni-viewer-core/viewers/drawio';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountDrawioViewer = createChromeCoreViewerMount('drawio', mountCoreViewer);

declare global { interface Window { __omniMountDrawio?: typeof mountDrawioViewer; } }
if (typeof window !== 'undefined') window.__omniMountDrawio = mountDrawioViewer;
