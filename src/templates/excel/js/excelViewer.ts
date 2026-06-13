// Webpack entry for the Chrome Excel viewer (issue #36).
//
// Self-registers with `VIEWER_REGISTRATIONS` (router-mutation pattern from
// #9 image / #16 pdf / #33 csv) so the in-page router dispatches Excel
// files to `mountExcelViewer` without requiring router.ts edits.

import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { mountExcelViewer } from './excelViewerMain';

const TARGET_VIEW_TYPE = 'omni-viewer.excelViewer';

const registration = VIEWER_REGISTRATIONS.find((r) => r.viewType === TARGET_VIEW_TYPE);
if (registration) {
    registration.createProvider = (): ChromeViewerProvider => ({
        async render(file: File, container: HTMLElement): Promise<void> {
            mountExcelViewer(file, container);
        }
    });
}

export { mountExcelViewer };
