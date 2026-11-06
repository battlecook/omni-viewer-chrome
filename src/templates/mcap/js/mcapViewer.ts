import { mountSelfLoadingMcapViewer as mountCoreViewer } from 'omni-viewer-core/viewers/mcap/self-loading';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountMcapViewer = createChromeCoreViewerMount('mcap', mountCoreViewer);

declare global { interface Window { __omniMountMcap?: typeof mountMcapViewer; } }
if (typeof window !== 'undefined') window.__omniMountMcap = mountMcapViewer;
