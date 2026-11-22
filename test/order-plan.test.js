'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { claudePlanLabel } = require('../src/providers/claude');
const { sanitizeSettings, normalizeOrder, DEFAULTS } = require('../src/settings');

test('claudePlanLabel maps known account shapes', () => {
  assert.strictEqual(claudePlanLabel({ rate_limit_tier: 'default_claude_max_5x' }), 'Max 5x');
  assert.strictEqual(claudePlanLabel({ rate_limit_tier: 'default_claude_max_20x' }), 'Max 20x');
  assert.strictEqual(claudePlanLabel({ capabilities: ['chat', 'claude_pro'] }), 'Pro');
  assert.strictEqual(claudePlanLabel({ capabilities: ['chat', 'claude_max'] }), 'Max');
  assert.strictEqual(claudePlanLabel({ capabilities: ['chat', 'raven'] }), 'Team');
  assert.strictEqual(claudePlanLabel({ capabilities: ['chat'] }), null);
  assert.strictEqual(claudePlanLabel(null), null);
});

test('normalizeOrder keeps a full duplicate-free list of known ids', () => {
  assert.deepStrictEqual(normalizeOrder(['muse', 'claude']), ['muse', 'claude', 'chatgpt', 'gemini']);
  assert.deepStrictEqual(normalizeOrder(['x', 'muse', 'muse']), ['muse', 'claude', 'chatgpt', 'gemini']);
  assert.deepStrictEqual(normalizeOrder(undefined), ['claude', 'chatgpt', 'muse', 'gemini']);
});

test('sanitizeSettings accepts a new providerOrder and ignores no-ops', () => {
  const cur = { ...DEFAULTS };
  assert.deepStrictEqual(sanitizeSettings({ providerOrder: ['muse', 'claude', 'chatgpt', 'gemini'] }, cur), { providerOrder: ['muse', 'claude', 'chatgpt', 'gemini'] });
  assert.deepStrictEqual(sanitizeSettings({ providerOrder: ['claude', 'chatgpt', 'muse', 'gemini'] }, cur), {});
  assert.deepStrictEqual(sanitizeSettings({ providerOrder: 'nope' }, cur), {});
});

test('single-meter providers (Muse) are forced to always show, even from a saved auto', () => {
  const { mergeProvider } = require('../src/settings');
  assert.strictEqual(mergeProvider('muse', null, { enabled: true, weekly: 'auto' }).weekly, 'show');
  assert.strictEqual(mergeProvider('muse', { weekly: 'hide' }, { enabled: true }).weekly, 'show');
  assert.strictEqual(mergeProvider('claude', { weekly: 'auto' }, {}).weekly, 'auto');
});

test('meter modes: 5-hour always shows; weekly is show|auto; saved hide/auto values are repaired', () => {
  const { mergeProvider, allowedModes } = require('../src/settings');
  assert.deepStrictEqual(allowedModes('claude', 'fiveHour'), ['show']);
  assert.deepStrictEqual(allowedModes('claude', 'weekly'), ['show', 'auto']);
  assert.deepStrictEqual(allowedModes('muse', 'weekly'), ['show']);
  const m = mergeProvider('chatgpt', null, { enabled: true, fiveHour: 'auto', weekly: 'hide' });
  assert.strictEqual(m.fiveHour, 'show'); // no choice any more
  assert.strictEqual(m.weekly, 'auto'); // a saved hide becomes show-when-high
  assert.strictEqual(mergeProvider('gemini', { weekly: 'auto' }, {}).weekly, 'auto');
  assert.strictEqual(mergeProvider('gemini', { fiveHour: 'hide' }, {}).fiveHour, 'show');
});

test('palettes: seven choices, each tool has a default, and there is no app-wide colour setting', () => {
  const { PALETTES, DEFAULT_PALETTE, PROVIDER_IDS } = require('../src/settings');
  assert.deepStrictEqual(PALETTES, ['violet', 'ocean', 'teal', 'forest', 'rose', 'orange', 'graphite']);
  assert.deepStrictEqual(DEFAULT_PALETTE, { claude: 'orange', chatgpt: 'forest', muse: 'ocean', gemini: 'graphite' });
  for (const id of PROVIDER_IDS) assert.ok(PALETTES.includes(DEFAULT_PALETTE[id]), `${id} default is a real palette`);
  assert.strictEqual('palette' in DEFAULTS, false);
  assert.deepStrictEqual(sanitizeSettings({ palette: 'ocean' }, { ...DEFAULTS }), {}); // the old global key is ignored
});

test('per-tool palette: defaults to Auto, accepts a palette, repairs bad saved values', () => {
  const { mergeProvider } = require('../src/settings');
  const { buildProviderView } = require('../src/visibility');
  assert.strictEqual(DEFAULTS.providers.claude.palette, 'default');
  assert.strictEqual(mergeProvider('claude', { palette: 'rose' }, {}).palette, 'rose');
  assert.strictEqual(mergeProvider('claude', { palette: 'default' }, { palette: 'rose' }).palette, 'default');
  assert.strictEqual(mergeProvider('claude', { palette: 'neon' }, { palette: 'ocean' }).palette, 'ocean'); // bad input ignored
  assert.strictEqual(mergeProvider('claude', null, { palette: 'neon' }).palette, 'default'); // bad saved value repaired
  const out = sanitizeSettings({ providers: { gemini: { palette: 'teal' } } }, { ...DEFAULTS });
  assert.strictEqual(out.providers.gemini.palette, 'teal');
  assert.strictEqual(out.providers.claude.palette, 'default');
  assert.deepStrictEqual(sanitizeSettings({ providers: { gemini: { palette: 'default' } } }, { ...DEFAULTS }), {});
  const view = buildProviderView({ id: 'gemini', name: 'Gemini', meterDefs: [] }, { auth: 'signed-in' }, { enabled: true, palette: 'teal' }, 80);
  assert.strictEqual(view.palette, 'teal');
  assert.strictEqual(view.effectivePalette, 'teal');
  const auto = buildProviderView({ id: 'gemini', name: 'Gemini', meterDefs: [] }, { auth: 'signed-in' }, { enabled: true }, 80);
  assert.strictEqual(auto.palette, 'default');
  assert.strictEqual(auto.effectivePalette, 'graphite'); // Auto = Gemini's own default
  assert.strictEqual(buildProviderView({ id: 'claude', name: 'Claude', meterDefs: [] }, { auth: 'signed-in' }, { enabled: true, palette: 'default' }, 80).effectivePalette, 'orange');
});
