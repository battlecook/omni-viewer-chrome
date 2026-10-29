// GeoJSON viewer — Chrome adapter over omni-viewer-core.
import { mountGeoJsonViewer as mountCoreViewer } from 'omni-viewer-core/viewers/geojson';
import { createChromeCoreViewerMount } from '../../../utils/coreViewerAdapter';

export const mountGeoJsonViewer = createChromeCoreViewerMount('geojson', mountCoreViewer);

declare global { interface Window { __omniMountGeoJson?: typeof mountGeoJsonViewer; } }
if (typeof window !== 'undefined') window.__omniMountGeoJson = mountGeoJsonViewer;
