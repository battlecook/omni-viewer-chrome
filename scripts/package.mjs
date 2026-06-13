#!/usr/bin/env node
/**
 * Build a clean Chrome Web Store zip from `dist/`.
 *
 * Pipeline:
 *   1. Verify `manifest.json.version === package.json.version`. Fail loudly
 *      if mismatched — the Web Store rejects mismatched payloads and CI tags
 *      depend on a single source of truth.
 *   2. Sanity-check that `dist/` exists and contains `manifest.json`. We do
 *      NOT auto-run `npm run build` here: the `package` npm script chains
 *      build → package, and CI runs them as separate steps. This keeps the
 *      script idempotent and quick to re-run during debugging.
 *   3. Stage `dist/` into a temp directory, prune unused vendor sub-files
 *      (unused wavesurfer plugins, non-esm wavesurfer build) and any *.map
 *      sourcemaps, then zip.
 *   4. Output: `dist/omni-viewer-<version>.zip`. Print final size.
 *
 * Why a stage dir instead of `zip -x` excludes? `zip -x` patterns are
 * brittle across macOS / GNU zip when nested globs are involved; copying a
 * pruned tree is portable and trivially auditable.
 *
 * No external deps: relies on Node builtins + the system `zip` CLI, which
 * ships on macOS, Linux, and ubuntu-latest GitHub runners.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Step 1: version sync gate. */
function verifyVersions() {
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const manifest = readJson(path.join(repoRoot, 'manifest.json'));
  if (pkg.version !== manifest.version) {
    console.error(
      `[package] Version mismatch: package.json=${pkg.version} ` +
        `vs manifest.json=${manifest.version}. Bump both before packaging.`
    );
    process.exit(1);
  }
  console.log(`[package] Version sync OK (${pkg.version}).`);
  return pkg.version;
}

/** Step 2: dist sanity check. */
function ensureDistReady() {
  const distManifest = path.join(distDir, 'manifest.json');
  if (!fs.existsSync(distManifest)) {
    console.error(
      `[package] ${distManifest} not found. Run \`npm run build\` first ` +
        `(or use \`npm run package\` which chains build+package).`
    );
    process.exit(1);
  }
}

/**
 * Vendor pruning rules. Anything whose POSIX path (relative to dist/) matches
 * an entry here is dropped from the staged copy.
 *
 * Only wavesurfer ships unused siblings — keep this list minimal so future
 * vendor additions aren't accidentally excluded.
 */
const PRUNE_RELATIVE_PATHS = new Set([
  // Non-ESM wavesurfer build; app.js uses the .esm.js entry.
  'vendor/wavesurfer/wavesurfer.js',
  // Plugins not registered by app.js.
  'vendor/wavesurfer/plugins/envelope.js',
  'vendor/wavesurfer/plugins/record.js',
  'vendor/wavesurfer/plugins/spectrogram-windowed.js',
  'vendor/wavesurfer/plugins/spectrogram-worker.js',
  'vendor/wavesurfer/plugins/timeline.esm.js',
  'vendor/wavesurfer/plugins/zoom.js',
  'vendor/wavesurfer/plugins/zoom.esm.js'
]);

function shouldPrune(relPosix) {
  // Drop every sourcemap regardless of size: prod CSP forbids them and the
  // store penalises dead weight.
  if (relPosix.endsWith('.map')) return true;
  return PRUNE_RELATIVE_PATHS.has(relPosix);
}

function copyTreeFiltered(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  let kept = 0;
  let pruned = 0;
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      const rel = path.relative(srcDir, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (shouldPrune(rel)) {
        pruned += 1;
        continue;
      }
      const target = path.join(dstDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(abs, target);
      kept += 1;
    }
  };
  walk(srcDir);
  return { kept, pruned };
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(2)} ${units[i]}`;
}

function main() {
  const version = verifyVersions();
  ensureDistReady();

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-viewer-pkg-'));
  try {
    const stageRoot = path.join(stageDir, 'omni-viewer');
    const { kept, pruned } = copyTreeFiltered(distDir, stageRoot);
    console.log(`[package] Staged ${kept} files; pruned ${pruned}.`);

    const outZip = path.join(distDir, `omni-viewer-${version}.zip`);
    if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

    // `zip -r <out> .` from inside the stage root keeps the archive flat
    // (no `omni-viewer/` prefix) so chrome://extensions "Load unpacked" of
    // the extracted zip Just Works.
    execFileSync('zip', ['-r', '-X', outZip, '.'], {
      cwd: stageRoot,
      stdio: 'inherit'
    });

    const stat = fs.statSync(outZip);
    console.log(`[package] Created ${path.relative(repoRoot, outZip)} (${humanSize(stat.size)}).`);
    if (stat.size > 50 * 1024 * 1024) {
      console.warn(
        '[package] WARNING: zip exceeds 50 MB. Chrome Web Store hard limit ' +
          'is 100 MB; review vendor/ for unused assets.'
      );
    }
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

main();
