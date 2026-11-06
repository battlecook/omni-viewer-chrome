import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishWebStore } from '../publish-webstore.mjs';

const directory = mkdtempSync(path.join(tmpdir(), 'webstore-test-'));
writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ version: '0.11.0' }));
const zipPath = path.join(directory, 'release.zip');
execFileSync('zip', ['-q', zipPath, 'manifest.json'], { cwd: directory });
after(() => rmSync(directory, { recursive: true, force: true }));

function fixture(responses, overrides = {}) {
  const calls = [];
  const options = {
    zipPath, version: '0.11.0', publisherId: 'publisher-123',
    extensionId: 'mbhllahknhjahklfinmbnmdlpeommegd', accessToken: 'secret-token',
    sleep: async () => {}, log: () => {}, pollAttempts: 2,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      assert.ok(responses.length, `Unexpected request to ${url}`);
      const { status = 200, ...body } = responses.shift();
      return { ok: status < 400, status, json: async () => body };
    },
    ...overrides
  };
  return { options, calls };
}

test('uploads the actual ZIP then requests automatic publication after review', async () => {
  const { options, calls } = fixture([
    { uploadState: 'SUCCEEDED', crxVersion: '0.11.0' }, { state: 'PENDING_REVIEW' }
  ]);
  assert.equal((await publishWebStore(options)).state, 'PENDING_REVIEW');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://chromewebstore.googleapis.com/upload/v2/publishers/publisher-123/items/mbhllahknhjahklfinmbnmdlpeommegd:upload');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[0].body.subarray(0, 2).toString(), 'PK');
  assert.equal(calls[1].url.endsWith(':publish'), true);
  assert.deepEqual(JSON.parse(calls[1].body), { publishType: 'DEFAULT_PUBLISH' });
});

for (const initialState of ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']) {
  test(`waits for asynchronous upload (${initialState}) before publishing`, async () => {
    const { options, calls } = fixture([
      { uploadState: initialState }, { lastAsyncUploadState: 'IN_PROGRESS' },
      { lastAsyncUploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }
    ]);
    await publishWebStore(options);
    assert.equal(calls.length, 4);
    assert.ok(calls.slice(1, 3).every(call => call.url.endsWith(':fetchStatus')));
    assert.equal(calls[3].url.endsWith(':publish'), true);
  });
}

for (const uploadState of ['FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', undefined]) {
  test(`never publishes an unsuccessful upload (${uploadState})`, async () => {
    const { options, calls } = fixture([{ uploadState }]);
    await assert.rejects(publishWebStore(options), /Upload did not succeed/);
    assert.equal(calls.length, 1);
  });
}

test('never publishes when asynchronous upload times out', async () => {
  const { options, calls } = fixture([
    { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'IN_PROGRESS' },
    { lastAsyncUploadState: 'IN_PROGRESS' }
  ]);
  await assert.rejects(publishWebStore(options), /Upload did not succeed/);
  assert.equal(calls.length, 3);
});

test('checks the manifest inside the artifact before sending any request', async () => {
  const { options, calls } = fixture([], { version: '0.12.0' });
  await assert.rejects(publishWebStore(options), /ZIP version/);
  assert.equal(calls.length, 0);
});

test('rejects a different version reported by the upload API', async () => {
  const { options, calls } = fixture([{ uploadState: 'SUCCEEDED', crxVersion: '0.10.0' }]);
  await assert.rejects(publishWebStore(options), /Uploaded version/);
  assert.equal(calls.length, 1);
});

test('fails on missing credentials before sending any request', async () => {
  const { options, calls } = fixture([], { accessToken: '' });
  await assert.rejects(publishWebStore(options), /Missing accessToken/);
  assert.equal(calls.length, 0);
});

for (const status of [200, 403]) {
  test(`surfaces API errors without exposing tokens (HTTP ${status})`, async () => {
    const { options, calls } = fixture([{ status, error: { message: 'rejected secret-token' } }]);
    await assert.rejects(publishWebStore(options), error => {
      assert.match(error.message, /rejected \[REDACTED\]/);
      assert.ok(!error.message.includes('secret-token'));
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test('fails when the publish API returns a rejected state', async () => {
  const { options } = fixture([{ uploadState: 'SUCCEEDED' }, { state: 'REJECTED' }]);
  await assert.rejects(publishWebStore(options), /Unexpected submission state: REJECTED/);
});
