// Font viewer — Chrome adapter over omni-viewer-core.
import { mountFontViewer as mountCoreViewer } from 'omni-viewer-core/viewers/font';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountFontViewer = createChromeCoreViewerMount('font', mountCoreViewer);

declare global { interface Window { __omniMountFont?: typeof mountFontViewer; } }
if (typeof window !== 'undefined') window.__omniMountFont = mountFontViewer;
