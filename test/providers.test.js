'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeUsage } = require('../src/providers/claude');
const { parseChatGptUsage, classifyWindow } = require('../src/providers/chatgpt');
const { toReading } = require('../src/providers/muse');
const { PROVIDER_METERS } = require('../src/settings');
const registry = require('../src/providers');

// Shapes below are trimmed copies of real responses captured during recon.
const CLAUDE_SAMPLE = {
  five_hour: { utilization: 19, resets_at: '2026-11-22T18:40:00.209121+00:00' },
  seven_day: { utilization: 43, resets_at: '2026-11-25T05:00:00.209140+00:00' },
  seven_day_opus: null,
  limits: [
    { kind: 'session', group: 'session', percent: 19, resets_at: '2026-11-22T18:40:00.209121+00:00', is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 43, resets_at: '2026-11-25T05:00:00.209140+00:00', is_active: true },
  ],
};

test('claude: reads five_hour and seven_day', () => {
  const r = parseClaudeUsage(CLAUDE_SAMPLE);
  assert.equal(r.meters.fiveHour.percent, 19);
  assert.equal(r.meters.weekly.percent, 43);
  assert.equal(r.meters.fiveHour.resetsAtMs, Date.parse('2026-11-22T18:40:00.209121+00:00'));
  assert.equal(r.meters.weekly.resetsAtMs, Date.parse('2026-11-25T05:00:00.209140+00:00'));
});

test('claude: falls back to limits[] when the top-level windows are null', () => {
  const r = parseClaudeUsage({ five_hour: null, seven_day: null, limits: CLAUDE_SAMPLE.limits });
  assert.equal(r.meters.fiveHour.percent, 19);
  assert.equal(r.meters.weekly.percent, 43);
});

test('claude: an idle 5-hour window leaves only the weekly meter', () => {
  const r = parseClaudeUsage({ five_hour: null, seven_day: CLAUDE_SAMPLE.seven_day });
  assert.equal(r.meters.fiveHour, undefined);
  assert.equal(r.meters.weekly.percent, 43);
});

test('claude: unrecognised payloads give null', () => {
  assert.equal(parseClaudeUsage(null), null);
  assert.equal(parseClaudeUsage('nope'), null);
  assert.equal(parseClaudeUsage({ five_hour: null, seven_day: null }), null);
});

test('claude: percent is clamped to 0..100', () => {
  const r = parseClaudeUsage({ five_hour: { utilization: 140, resets_at: null }, seven_day: { utilization: -3, resets_at: null } });
  assert.equal(r.meters.fiveHour.percent, 100);
  assert.equal(r.meters.weekly.percent, 0);
  assert.equal(r.meters.fiveHour.resetsAtMs, null);
});

const CHATGPT_SAMPLE = {
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 8746, reset_at: 1795378594 },
    secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 367774, reset_at: 1795737621 },
  },
};

test('chatgpt: maps windows by length and converts Unix seconds', () => {
  const r = parseChatGptUsage(CHATGPT_SAMPLE);
  assert.equal(r.plan, 'plus');
  assert.equal(r.meters.fiveHour.percent, 1);
  assert.equal(r.meters.weekly.percent, 0);
  assert.equal(r.meters.fiveHour.resetsAtMs, 1795378594 * 1000);
  assert.equal(r.meters.weekly.resetsAtMs, 1795737621 * 1000);
});

test('chatgpt: classification does not depend on primary/secondary order', () => {
  const swapped = {
    plan_type: 'pro',
    rate_limit: { primary_window: CHATGPT_SAMPLE.rate_limit.secondary_window, secondary_window: CHATGPT_SAMPLE.rate_limit.primary_window },
  };
  const r = parseChatGptUsage(swapped);
  assert.equal(r.meters.weekly.percent, 0);
  assert.equal(r.meters.fiveHour.percent, 1);
});

test('chatgpt: a weekly-only plan has just the weekly meter', () => {
  const r = parseChatGptUsage({ plan_type: 'free', rate_limit: { primary_window: CHATGPT_SAMPLE.rate_limit.secondary_window } });
  assert.deepEqual(Object.keys(r.meters), ['weekly']);
});

test('chatgpt: a plan with no rate limit is valid but has no meters', () => {
  const r = parseChatGptUsage({ plan_type: 'free', rate_limit: null });
  assert.equal(r.plan, 'free');
  assert.deepEqual(r.meters, {});
});

test('chatgpt: non-objects give null; odd window lengths are ignored', () => {
  assert.equal(parseChatGptUsage(null), null);
  assert.equal(classifyWindow({ limit_window_seconds: 86400 }), null);
  assert.equal(classifyWindow({}), null);
});

test('muse: wraps the normalized usage as a weekly meter', () => {
  const r = toReading({ percentUsed: 53, resetsAtMs: 1795272931000, tierName: 'Free' });
  assert.equal(r.plan, 'Free');
  assert.equal(r.meters.weekly.percent, 53);
  assert.equal(r.meters.weekly.resetsAtMs, 1795272931000);
});

test('registry: every provider is configured consistently with settings', () => {
  for (const p of registry.ALL) {
    assert.deepEqual(p.meterDefs.map((d) => d.id), PROVIDER_METERS[p.id], `${p.id} meters`);
    if (p.external) continue; // fed by a companion, no window of its own
    assert.ok(p.host && p.startUrl.includes(p.host), `${p.id} host/startUrl`);
    assert.match(p.partition, /^persist:aiw-/);
    assert.equal(typeof p.read, 'function');
  }
  assert.deepEqual(registry.ALL.map((p) => p.id), Object.keys(PROVIDER_METERS));
  const windowed = registry.ALL.filter((p) => !p.external);
  assert.equal(new Set(windowed.map((p) => p.partition)).size, windowed.length, 'one partition per windowed provider');
});
