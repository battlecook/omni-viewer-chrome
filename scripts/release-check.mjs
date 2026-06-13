#!/usr/bin/env node
/**
 * Lightweight pre-release gate: verify that `manifest.json.version` matches
 * `package.json.version`. Used by CI before kicking off the full build, and
 * runnable locally as `npm run release:check`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));

if (pkg.version !== manifest.version) {
  console.error(
    `[release:check] Version mismatch: package.json=${pkg.version} ` +
      `vs manifest.json=${manifest.version}.`
  );
  process.exit(1);
}

console.log(`[release:check] Versions in sync (${pkg.version}).`);
