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
  'hdf5',
  'archive',
  'json',
  'jsonl',
  'yaml',
  'toml',
  'markdown',
  'latex',
  'mermaid',
  'plantuml',
  'automotive',
  'mat',
  'numpy',
  'gguf',
  'onnx',
  'tflite',
  'keras',
  'coreml',
  'openvino',
  'safetensors',
  'proto'
];

const entries = VIEWERS.reduce((acc, viewer) => {
  acc[`templates/${viewer}/${viewer}Viewer`] =
    `./src/templates/${viewer}/js/${viewer}Viewer.ts`;
  return acc;
}, {});
entries['share/shareCommand'] = './src/shareCommand.ts';

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
      extensions: ['.ts', '.tsx', '.js'],
      // Optional peers imported by omni-viewer-core resolve relative to the
      // core package. Point them at this platform's installed dependency.
      alias: {
        yaml: require.resolve('yaml'),
        marked: require.resolve('marked'),
        dompurify: require.resolve('dompurify'),
        'highlight.js': require.resolve('highlight.js'),
        mermaid: require.resolve('mermaid'),
        katex: require.resolve('katex'),
        'docx-preview': require.resolve('docx-preview'),
        jszip: path.resolve(__dirname, 'node_modules/jszip/dist/jszip.min.js'),
        // hyparquet exposes only ESM import conditions, so CommonJS
        // require.resolve() cannot resolve its package root.
        hyparquet: path.resolve(__dirname, 'node_modules/hyparquet/src/index.js'),
        'hyparquet-compressors': require.resolve('hyparquet-compressors'),
        '@rhwp/core': require.resolve('@rhwp/core'),
        // puml-canvas-js only exposes an ESM import condition, so Node's
        // CommonJS require.resolve() cannot resolve its package root.
        'puml-canvas-js': path.resolve(
          __dirname,
          'node_modules/puml-canvas-js/dist/puml-canvas-js.js'
        )
      }
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
          { from: 'LICENSE', to: 'LICENSE', toType: 'file' },
          { from: 'THIRD-PARTY-NOTICES.md', to: 'THIRD-PARTY-NOTICES.md' },
          { from: 'THIRD-PARTY-LICENSES', to: 'THIRD-PARTY-LICENSES' },
          { from: 'viewer.html', to: 'viewer.html' },
          {
            from: 'src/templates/numpy/numpyViewer.html',
            to: 'templates/numpy/numpyViewer.html'
          },
          // Standalone page shell for the per-viewer debug flow
          // (`templates/safetensors/safetensorsViewer.html?src=...`). Without
          // it the bundle's `selfBootstrap` block can never fire.
          {
            from: 'src/templates/safetensors/safetensorsViewer.html',
            to: 'templates/safetensors/safetensorsViewer.html'
          },
          {
            from: 'src/templates/openvino/openvinoViewer.html',
            to: 'templates/openvino/openvinoViewer.html'
          },
          { from: '_locales', to: '_locales' },
          { from: 'icons', to: 'icons' },
          { from: 'vendor', to: 'vendor' },
          // PDF.js worker copied from the same npm install that webpack
          // bundles — keeps the API/worker versions locked together.
          {
            from: 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
            to: 'assets/pdfjs/pdf.worker.min.mjs'
          },
          // WASM audio decode/analysis engine shipped by omni-viewer-core.
          // The core's audio viewer resolves `audio-engine/*` through
          // AssetService; the adapter maps that onto dist/assets/ (which is
          // web-accessible), so worker + module + wasm must land together.
          {
            from: 'node_modules/omni-viewer-core/dist/assets/audio-engine',
            to: 'assets/audio-engine',
            // Ship the Emscripten glue + worker shell exactly as the core
            // built them; re-minifying generated wasm glue buys nothing and
            // is one more thing between a decode bug and its source.
            info: { minimized: true }
          },
          // KaTeX stylesheet + fonts. omni-viewer-core renders math into an
          // isolated shadow root but ships no math CSS by design — the adapter
          // loads katex.min.css (which references ./fonts/* relatively, so the
          // fonts dir must sit next to it) into that root.
          {
            from: 'node_modules/katex/dist/katex.min.css',
            to: 'assets/katex/katex.min.css'
          },
          {
            from: 'node_modules/katex/dist/fonts',
            to: 'assets/katex/fonts'
          },
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
