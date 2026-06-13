import fs from 'node:fs';

const required = [
  'manifest.json',
  'viewer.html',
  'src/background.js',
  'src/app.js',
  'src/styles.css',
  'vendor/xlsx.full.min.js',
  'vendor/jszip.min.js',
  'vendor/js-yaml.min.js',
  'vendor/docx-preview.min.js',
  'vendor/mammoth.browser.min.js',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
  'vendor/audio_engine_browser.js',
  'vendor/audio_engine.wasm',
  'vendor/wavesurfer/wavesurfer.esm.js',
  'vendor/wavesurfer/plugins/spectrogram.js',
  'vendor/wavesurfer/plugins/regions.js',
  'vendor/wavesurfer/plugins/timeline.js',
  'vendor/wavesurfer/plugins/minimap.js',
  'vendor/wavesurfer/plugins/hover.js'
];

let failed = false;
for (const file of required) {
  if (!fs.existsSync(file)) {
    console.error(`Missing required file: ${file}`);
    failed = true;
  }
}

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
if (manifest.manifest_version !== 3) {
  console.error('manifest_version must be 3.');
  failed = true;
}

const html = fs.readFileSync('viewer.html', 'utf8');
if (/https?:\/\//.test(html)) {
  console.error('viewer.html must not include remote scripts or styles.');
  failed = true;
}

if (failed) process.exit(1);
console.log('Extension validation passed.');
