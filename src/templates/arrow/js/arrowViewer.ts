// Arrow / Feather viewer — Chrome adapter over omni-viewer-core.
import { mountSelfLoadingArrowViewer as mountCoreViewer } from 'omni-viewer-core/viewers/arrow/self-loading';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountArrowViewer = createChromeCoreViewerMount('arrow', mountCoreViewer);

declare global { interface Window { __omniMountArrow?: typeof mountArrowViewer; } }
if (typeof window !== 'undefined') window.__omniMountArrow = mountArrowViewer;
