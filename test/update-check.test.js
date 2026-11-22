'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, isNewerVersion, checkForUpdate } = require('../src/update-check');

test('parseVersion accepts v-prefix and pre-release, rejects junk', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { core: [1, 2, 3], pre: '' });
  assert.deepEqual(parseVersion('0.1.0-rc.1'), { core: [0, 1, 0], pre: 'rc.1' });
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
});

test('isNewerVersion compares numerically, not as text', () => {
  assert.equal(isNewerVersion('0.10.0', '0.9.0'), true);
  assert.equal(isNewerVersion('1.0.0', '0.9.9'), true);
  assert.equal(isNewerVersion('0.1.1', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
  assert.equal(isNewerVersion('0.1.0', '0.1.1'), false);
  assert.equal(isNewerVersion('v0.2.0', '0.1.0'), true);
});

test('release is newer than its own pre-release; pre-releases order correctly', () => {
  assert.equal(isNewerVersion('1.0.0', '1.0.0-rc.1'), true);
  assert.equal(isNewerVersion('1.0.0-rc.1', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0-rc.2', '1.0.0-rc.1'), true);
  assert.equal(isNewerVersion('1.0.0-rc.10', '1.0.0-rc.9'), true);
  assert.equal(isNewerVersion('1.0.0-rc.1', '1.0.0-rc.1'), false);
});

test('unparseable versions are never newer', () => {
  assert.equal(isNewerVersion('nightly', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', 'dev'), false);
});

const fakeFetch = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('checkForUpdate returns release info when newer', async () => {
  const body = { tag_name: 'v0.2.0', html_url: 'https://example.test/rel', draft: false, prerelease: false };
  assert.deepEqual(await checkForUpdate('0.1.0', fakeFetch(200, body)), { version: '0.2.0', url: 'https://example.test/rel' });
});

test('checkForUpdate is null for same/older, pre-release, draft and 404', async () => {
  const mk = (extra) => ({ tag_name: 'v0.2.0', html_url: 'u', draft: false, prerelease: false, ...extra });
  assert.equal(await checkForUpdate('0.2.0', fakeFetch(200, mk({}))), null);
  assert.equal(await checkForUpdate('0.1.0', fakeFetch(200, mk({ prerelease: true }))), null);
  assert.equal(await checkForUpdate('0.1.0', fakeFetch(200, mk({ draft: true }))), null);
  assert.equal(await checkForUpdate('0.1.0', fakeFetch(404, {})), null);
});

test('checkForUpdate throws on server errors', async () => {
  await assert.rejects(() => checkForUpdate('0.1.0', fakeFetch(500, {})), /HTTP 500/);
});
