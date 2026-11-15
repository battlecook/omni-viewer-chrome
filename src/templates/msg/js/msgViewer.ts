import { mountMsgViewer as mountCoreViewer } from 'omni-viewer-core/viewers/msg';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountMsgViewer = createChromeCoreViewerMount('msg', mountCoreViewer);

declare global { interface Window { __omniMountMsg?: typeof mountMsgViewer; } }
if (typeof window !== 'undefined') window.__omniMountMsg = mountMsgViewer;
