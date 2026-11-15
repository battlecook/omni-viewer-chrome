import { mountTraceViewer as mountCoreViewer } from 'omni-viewer-core/viewers/trace';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountTraceViewer = createChromeCoreViewerMount('trace', mountCoreViewer);

declare global { interface Window { __omniMountTrace?: typeof mountTraceViewer; } }
if (typeof window !== 'undefined') window.__omniMountTrace = mountTraceViewer;
