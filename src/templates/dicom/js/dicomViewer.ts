import { mountDicomViewer as mountCoreViewer } from 'omni-viewer-core/viewers/dicom';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountDicomViewer = createChromeCoreViewerMount('dicom', mountCoreViewer);

declare global { interface Window { __omniMountDicom?: typeof mountDicomViewer; } }
if (typeof window !== 'undefined') window.__omniMountDicom = mountDicomViewer;
