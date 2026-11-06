import { mountEmlViewer as mountCoreViewer } from 'omni-viewer-core/viewers/eml';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountEmlViewer = createChromeCoreViewerMount('eml', mountCoreViewer);

declare global { interface Window { __omniMountEml?: typeof mountEmlViewer; } }
if (typeof window !== 'undefined') window.__omniMountEml = mountEmlViewer;
