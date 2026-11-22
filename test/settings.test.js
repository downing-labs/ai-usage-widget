'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, sanitizeSettings } = require('../src/settings');

const cur = () => JSON.parse(JSON.stringify(DEFAULTS));

test('defaults: nothing enabled, meters set to show', () => {
  assert.equal(DEFAULTS.providers.claude.enabled, false);
  assert.equal(DEFAULTS.providers.claude.fiveHour, 'show');
  assert.equal(DEFAULTS.providers.muse.weekly, 'show');
  assert.equal(DEFAULTS.providers.muse.fiveHour, undefined);
  assert.equal(DEFAULTS.autoShowPercent, 75);
  assert.equal(DEFAULTS.trayProvider, 'highest');
});

test('non-objects and unknown keys change nothing', () => {
  assert.deepEqual(sanitizeSettings(null, cur()), {});
  assert.deepEqual(sanitizeSettings({ bogus: 1 }, cur()), {});
});

test('simple settings: valid values pass, invalid and unchanged ones are dropped', () => {
  const c = cur();
  assert.deepEqual(sanitizeSettings({ pollSeconds: 60, theme: 'dark', timeFormat: '24h', compactMode: true }, c),
    { pollSeconds: 60, theme: 'dark', timeFormat: '24h', compactMode: true });
  assert.deepEqual(sanitizeSettings({ pollSeconds: 7, theme: 'neon', timeFormat: 'x', compactMode: 'yes' }, c), {});
  assert.deepEqual(sanitizeSettings({ pollSeconds: 300, theme: 'system' }, c), {});
});

test('thresholds: warn must stay below danger, both or neither', () => {
  const c = cur();
  assert.deepEqual(sanitizeSettings({ warnPercent: 60, dangerPercent: 85 }, c), { warnPercent: 60, dangerPercent: 85 });
  assert.deepEqual(sanitizeSettings({ warnPercent: 95 }, c), {});
  assert.deepEqual(sanitizeSettings({ warnPercent: 5 }, c), {});
  assert.deepEqual(sanitizeSettings({ dangerPercent: 100 }, c), {});
});

test('autoShowPercent: whole percent from 10 to 99', () => {
  const c = cur();
  assert.deepEqual(sanitizeSettings({ autoShowPercent: 70 }, c), { autoShowPercent: 70 });
  assert.deepEqual(sanitizeSettings({ autoShowPercent: 100 }, c), {});
  assert.deepEqual(sanitizeSettings({ autoShowPercent: 5 }, c), {});
  assert.deepEqual(sanitizeSettings({ autoShowPercent: 75 }, c), {});
});

test('trayProvider: highest or a known provider id', () => {
  const c = cur();
  assert.deepEqual(sanitizeSettings({ trayProvider: 'claude' }, c), { trayProvider: 'claude' });
  assert.deepEqual(sanitizeSettings({ trayProvider: 'bard' }, c), {});
  c.trayProvider = 'claude';
  assert.deepEqual(sanitizeSettings({ trayProvider: 'highest' }, c), { trayProvider: 'highest' });
});

test('providers: enabling one returns the whole merged object, others untouched', () => {
  const c = cur();
  const out = sanitizeSettings({ providers: { claude: { enabled: true } } }, c);
  assert.equal(out.providers.claude.enabled, true);
  assert.equal(out.providers.chatgpt.enabled, false);
  assert.equal(out.providers.claude.weekly, 'show');
});

test('providers: meter modes validated, unknown meters and providers ignored', () => {
  const c = cur();
  const out = sanitizeSettings({ providers: { claude: { fiveHour: 'show', weekly: 'auto' }, muse: { fiveHour: 'hide' } } }, c);
  assert.equal(out.providers.claude.weekly, 'auto');
  assert.equal(out.providers.muse.fiveHour, undefined);
  assert.deepEqual(sanitizeSettings({ providers: { claude: { weekly: 'sometimes' } } }, c), {});
  assert.deepEqual(sanitizeSettings({ providers: { bard: { enabled: true } } }, c), {});
  assert.deepEqual(sanitizeSettings({ providers: { claude: { enabled: 'yes' } } }, c), {});
});

test('providers: a no-op change returns nothing', () => {
  assert.deepEqual(sanitizeSettings({ providers: { claude: { enabled: false, weekly: 'show' } } }, cur()), {});
});

test('providers: stored config missing a provider still merges onto defaults', () => {
  const c = cur();
  c.providers = { claude: { enabled: true, fiveHour: 'show', weekly: 'show' } };
  const out = sanitizeSettings({ providers: { muse: { enabled: true } } }, c);
  assert.equal(out.providers.claude.enabled, true);
  assert.equal(out.providers.muse.enabled, true);
  assert.equal(out.providers.chatgpt.enabled, false);
});
