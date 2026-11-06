import { mountSelfLoadingOpenApiViewer as mountCoreViewer } from 'omni-viewer-core/viewers/openapi/self-loading';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountOpenApiViewer = createChromeCoreViewerMount('openapi', mountCoreViewer);

declare global { interface Window { __omniMountOpenApi?: typeof mountOpenApiViewer; } }
if (typeof window !== 'undefined') window.__omniMountOpenApi = mountOpenApiViewer;
