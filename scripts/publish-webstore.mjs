#!/usr/bin/env node
/** Upload the tested release ZIP using Chrome Web Store API v2. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://chromewebstore.googleapis.com';
const inProgress = (state) => ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS'].includes(state);

export async function publishWebStore({
  zipPath, version, publisherId, extensionId, accessToken,
  fetchImpl = globalThis.fetch, sleep = delay, log = console.log,
  pollAttempts = 60, pollIntervalMs = 10_000
}) {
  for (const [name, value] of Object.entries({ zipPath, version, publisherId, extensionId, accessToken })) {
    if (!value) throw new Error(`Missing ${name}. See store/automatic-publishing.md.`);
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('Invalid release version.');
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid Chrome Web Store extension ID.');
  if (!/^[a-zA-Z0-9_-]+$/.test(publisherId)) throw new Error('Invalid publisher ID.');

  // Inspect the downloaded artifact itself before authenticating any request.
  const manifest = JSON.parse(execFileSync('unzip', ['-p', path.resolve(zipPath), 'manifest.json'], { encoding: 'utf8' }));
  if (manifest.version !== version) {
    throw new Error(`ZIP version ${manifest.version} does not match release ${version}.`);
  }
  const zip = readFileSync(zipPath);
  const resource = `publishers/${publisherId}/items/${extensionId}`;
  const itemUrl = `${API}/v2/${resource}`;

  async function request(url, options = {}) {
    const response = await fetchImpl(url, {
      ...options,
      headers: { Authorization: `Bearer ${accessToken}`, ...options.headers },
      signal: AbortSignal.timeout(120_000)
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      const detail = body.error?.message || body.error?.status || 'Unexpected API response';
      throw new Error(`Chrome Web Store API (${response.status}): ${String(detail).replaceAll(accessToken, '[REDACTED]')}`);
    }
    return body;
  }

  log(`Uploading version ${version} to Chrome Web Store…`);
  const upload = await request(`${API}/upload/v2/${resource}:upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip
  });
  if (upload.crxVersion && upload.crxVersion !== version) {
    throw new Error(`Uploaded version ${upload.crxVersion} does not match release ${version}.`);
  }
  let state = upload.uploadState;
  for (let attempt = 0; inProgress(state) && attempt < pollAttempts; attempt += 1) {
    await sleep(pollIntervalMs);
    const status = await request(`${itemUrl}:fetchStatus`);
    state = status.lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') {
    throw new Error(`Upload did not succeed (${state || 'unknown state'}). No publish request was sent.`);
  }

  const result = await request(`${itemUrl}:publish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' })
  });
  if (!['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(result.state)) {
    throw new Error(`Unexpected submission state: ${result.state || 'unknown'}. Check the Developer Dashboard.`);
  }
  log(`Chrome Web Store submission accepted: ${result.state}. Google review may still be pending.`);
  for (const warning of result.warningInfo?.warnings ?? []) {
    log(`Web Store warning: ${warning.reason}: ${warning.description}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishWebStore({
    zipPath: process.argv[2], version: process.env.RELEASE_VERSION,
    publisherId: process.env.CWS_PUBLISHER_ID, extensionId: process.env.CWS_EXTENSION_ID,
    accessToken: process.env.CWS_ACCESS_TOKEN
  }).then((result) => {
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `Chrome Web Store version ${process.env.RELEASE_VERSION}: **${result.state}**. Submitted for automatic publication after Google approval.\n`);
    }
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(process.env.CWS_ACCESS_TOKEN ? message.replaceAll(process.env.CWS_ACCESS_TOKEN, '[REDACTED]') : message);
    process.exitCode = 1;
  });
}
