import { mountJUnitViewer as mountCoreViewer } from 'omni-viewer-core/viewers/junit';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountJUnitViewer = createChromeCoreViewerMount('junit', mountCoreViewer);

declare global { interface Window { __omniMountJUnit?: typeof mountJUnitViewer; } }
if (typeof window !== 'undefined') window.__omniMountJUnit = mountJUnitViewer;
