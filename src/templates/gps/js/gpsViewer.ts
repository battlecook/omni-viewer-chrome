import { mountGpsViewer as mountCoreViewer } from 'omni-viewer-core/viewers/gps';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountGpsViewer = createChromeCoreViewerMount('gps', mountCoreViewer);

declare global { interface Window { __omniMountGps?: typeof mountGpsViewer; } }
if (typeof window !== 'undefined') window.__omniMountGps = mountGpsViewer;
