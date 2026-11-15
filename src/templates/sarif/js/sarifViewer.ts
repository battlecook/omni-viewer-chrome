import { mountSarifViewer as mountCoreViewer } from 'omni-viewer-core/viewers/sarif';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountSarifViewer = createChromeCoreViewerMount('sarif', mountCoreViewer);

declare global { interface Window { __omniMountSarif?: typeof mountSarifViewer; } }
if (typeof window !== 'undefined') window.__omniMountSarif = mountSarifViewer;
