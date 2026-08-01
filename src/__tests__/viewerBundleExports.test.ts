// Smoke test for issue #73: webpack viewer bundles must expose
// `mount<Viewer>Viewer` as a named ESM export so the legacy SPA's
// `mountAdvancedViewer(slug, mountFnName, body)` can find it after a
// `dynamic import()`.
//
// Reads each `dist/templates/<slug>/<slug>Viewer.js` and asserts the
// bundle declares the export. Skips if the build output is missing —
// the build is part of the npm test script chain in CI but locally a
// dev may run `npm test` without a fresh `npm run build`.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const distRoot = resolve(__dirname, '../../dist/templates');

const VIEWERS: Array<{ slug: string; mountFn: string }> = [
    { slug: 'image', mountFn: 'mountImageViewer' },
    { slug: 'pdf', mountFn: 'mountPdfViewer' },
    { slug: 'csv', mountFn: 'mountCsvViewer' },
    { slug: 'excel', mountFn: 'mountExcelViewer' },
    { slug: 'parquet', mountFn: 'mountParquetViewer' },
    { slug: 'word', mountFn: 'mountWordViewer' },
    { slug: 'ppt', mountFn: 'mountPptViewer' },
    { slug: 'psd', mountFn: 'mountPsdViewer' },
    { slug: 'hwp', mountFn: 'mountHwpViewer' },
    { slug: 'archive', mountFn: 'mountArchiveViewer' },
    { slug: 'json', mountFn: 'mountJsonViewer' },
    { slug: 'jsonl', mountFn: 'mountJsonlViewer' },
    { slug: 'yaml', mountFn: 'mountYamlViewer' },
    { slug: 'toml', mountFn: 'mountTomlViewer' },
    { slug: 'markdown', mountFn: 'mountMarkdownViewer' },
    { slug: 'latex', mountFn: 'mountLatexViewer' },
    { slug: 'mermaid', mountFn: 'mountMermaidViewer' },
    { slug: 'plantuml', mountFn: 'mountPlantUmlViewer' },
    { slug: 'proto', mountFn: 'mountProtoViewer' },
    { slug: 'automotive', mountFn: 'mountAutomotiveViewer' },
    { slug: 'video', mountFn: 'mountVideoViewer' },
];

describe('viewer bundle named exports (#73)', () => {
    const someBundleExists = existsSync(
        resolve(distRoot, 'pdf', 'pdfViewer.js')
    );

    if (!someBundleExists) {
        // No-op when dist/ hasn't been built. Still keeps a passing
        // assertion so the suite isn't skipped silently.
        it('skipped: dist/ not built (run `npm run build` first)', () => {
            expect(true).toBe(true);
        });
        return;
    }

    it.each(VIEWERS)(
        '$slug bundle exposes $mountFn as a named ESM export',
        ({ slug, mountFn }) => {
            const bundlePath = resolve(distRoot, slug, `${slug}Viewer.js`);
            const source = readFileSync(bundlePath, 'utf8');
            const exportPattern = new RegExp(
                `export\\s*\\{[^}]*\\bas\\s+${mountFn}\\b`
            );
            expect(source).toMatch(exportPattern);
        }
    );
});
