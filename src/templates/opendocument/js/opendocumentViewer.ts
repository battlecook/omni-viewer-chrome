import { mountOpenDocumentViewer as mountCoreViewer } from 'omni-viewer-core/viewers/opendocument';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountOpenDocumentViewer = createChromeCoreViewerMount('opendocument', mountCoreViewer);

declare global { interface Window { __omniMountOpenDocument?: typeof mountOpenDocumentViewer; } }
if (typeof window !== 'undefined') window.__omniMountOpenDocument = mountOpenDocumentViewer;
