import { mountTextViewer as mountCoreViewer } from 'omni-viewer-core/viewers/text';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountTextViewer = createChromeCoreViewerMount('text', mountCoreViewer);

declare global { interface Window { __omniMountText?: typeof mountTextViewer; } }
if (typeof window !== 'undefined') window.__omniMountText = mountTextViewer;
