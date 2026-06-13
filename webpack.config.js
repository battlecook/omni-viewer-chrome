/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

/**
 * Chrome MV3 build for Omni Viewer.
 *
 * Output layout (under `dist/`):
 *   dist/manifest.json
 *   dist/viewer.html
 *   dist/icons/...
 *   dist/vendor/...
 *   dist/src/background.js          (passthrough copy — MV3 service worker)
 *   dist/src/app.js                 (passthrough copy of legacy SPA until later issues split it)
 *   dist/src/styles.css             (passthrough copy)
 *   dist/templates/<viewer>/<viewer>Viewer.js   (bundled entries)
 *
 * After `npm run build`, `dist/` is a self-contained "Load unpacked" target
 * for chrome://extensions. The repo root still has the original files so the
 * legacy unpacked flow (loading from the repo root) keeps working.
 */
const VIEWERS = [
  'image',
  'pdf',
  'audio',
  'video',
  'csv',
  'excel',
  'parquet',
  'word',
  'ppt',
  'psd',
  'hwp',
  'archive',
  'json',
  'jsonl',
  'yaml',
  'toml',
  'markdown',
  'mermaid',
  'plantuml',
  'automotive'
];

const entries = VIEWERS.reduce((acc, viewer) => {
  acc[`templates/${viewer}/${viewer}Viewer`] =
    `./src/templates/${viewer}/js/${viewer}Viewer.ts`;
  return acc;
}, {});

module.exports = (env, argv) => {
  const mode = (argv && argv.mode) || 'production';
  const isProd = mode === 'production';

  return {
    mode,
    target: 'web',
    entry: entries,
    // Webpack's default IIFE output drops named ESM exports — the legacy
    // SPA's `mountAdvancedViewer(slug, mountFnName, body)` reads
    // `mod[mountFnName]` after a `dynamic import()`, so we need ESM
    // library output to keep `mountPdfViewer` / `mountCsvViewer` / etc.
    // visible. Issue #73.
    experiments: {
      outputModule: true
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      module: true,
      library: { type: 'module' },
      chunkFormat: 'module',
      environment: {
        module: true,
        dynamicImport: true
      },
      clean: true
    },
    devtool: isProd ? false : 'source-map',
    resolve: {
      extensions: ['.ts', '.tsx', '.js']
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: [
            {
              loader: 'ts-loader',
              options: {
                transpileOnly: true,
                compilerOptions: {
                  // webpack handles the bundling, so each entry is treated
                  // as an isolated module.
                  noEmit: false
                }
              }
            }
          ]
        }
      ]
    },
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: 'manifest.json', to: 'manifest.json' },
          { from: 'viewer.html', to: 'viewer.html' },
          { from: '_locales', to: '_locales' },
          { from: 'icons', to: 'icons' },
          { from: 'vendor', to: 'vendor' },
          // Legacy SPA + service worker are copied verbatim until follow-up
          // issues split per-viewer logic into the templates/ tree.
          { from: 'src/background.js', to: 'src/background.js' },
          { from: 'src/app.js', to: 'src/app.js' },
          { from: 'src/styles.css', to: 'src/styles.css' }
        ]
      })
    ],
    // Chrome MV3 service worker uses `self`/`globalThis`; nothing exotic
    // is needed here because `target: 'web'` already produces compatible code.
    performance: {
      hints: false
    }
  };
};
