'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { meterVisible, buildProviderView } = require('../src/visibility');
const { pickTrayState, trayTooltip, macTrayTitle, TOOLTIP_MAX } = require('../src/tray-text');

const CLAUDE = { id: 'claude', name: 'Claude', meterDefs: [{ id: 'fiveHour', label: '5-hour' }, { id: 'weekly', label: 'Weekly' }] };
const MUSE = { id: 'muse', name: 'Muse', meterDefs: [{ id: 'weekly', label: 'Weekly' }] };
const reading = (meters, plan = null) => ({ plan, meters });
const raw = (r, extra = {}) => ({ auth: 'signed-in', reading: r, lastGoodAt: 1, error: null, stale: false, busy: false, ...extra });

test('meterVisible: show, hide and auto with a threshold', () => {
  assert.equal(meterVisible('show', 0, 80), true);
  assert.equal(meterVisible('hide', 99, 80), false);
  assert.equal(meterVisible('auto', 79, 80), false);
  assert.equal(meterVisible('auto', 80, 80), true);
  assert.equal(meterVisible('auto', null, 80), false);
});

test('buildProviderView: applies per-meter modes and the auto threshold', () => {
  const r = reading({ fiveHour: { percent: 10, resetsAtMs: 5 }, weekly: { percent: 85, resetsAtMs: 6 } }, 'max');
  const v = buildProviderView(CLAUDE, raw(r), { enabled: true, fiveHour: 'show', weekly: 'auto' }, 80);
  assert.equal(v.plan, 'max');
  assert.deepEqual(v.meters.map((m) => [m.id, m.visible]), [['fiveHour', true], ['weekly', true]]);
  const low = buildProviderView(CLAUDE, raw(reading({ fiveHour: { percent: 10 }, weekly: { percent: 40 } })), { enabled: true, fiveHour: 'show', weekly: 'auto' }, 80);
  assert.deepEqual(low.meters.map((m) => [m.id, m.visible]), [['fiveHour', true], ['weekly', false]]);
});

test('buildProviderView: a missing meter has no data but stays listed', () => {
  const v = buildProviderView(CLAUDE, raw(reading({ weekly: { percent: 43 } })), { enabled: true, fiveHour: 'show', weekly: 'show' }, 80);
  const five = v.meters.find((m) => m.id === 'fiveHour');
  assert.equal(five.hasData, false);
  assert.equal(five.percent, null);
  assert.equal(v.hasReading, true);
});

test('buildProviderView: no reading yet', () => {
  const v = buildProviderView(MUSE, raw(null, { auth: 'starting' }), { enabled: true, weekly: 'show' }, 80);
  assert.equal(v.hasReading, false);
  assert.equal(v.plan, null);
});

function views() {
  const claude = buildProviderView(CLAUDE, raw(reading({ fiveHour: { percent: 19 }, weekly: { percent: 43 } })), { enabled: true, fiveHour: 'show', weekly: 'show' }, 80);
  const muse = buildProviderView(MUSE, raw(reading({ weekly: { percent: 53 } })), { enabled: true, weekly: 'show' }, 80);
  return { claude, muse };
}

const cl = (five, weekly) => buildProviderView(CLAUDE, raw(reading({ fiveHour: { percent: five }, weekly: { percent: weekly } })), { enabled: true, fiveHour: 'show', weekly: 'show' }, 80);
const mu = (weekly) => buildProviderView(MUSE, raw(reading({ weekly: { percent: weekly } })), { enabled: true, weekly: 'show' }, 80);

const T = { weekly: 75, danger: 90 };
const GEMINI = { id: 'gemini', name: 'Gemini', meterDefs: [{ id: 'fiveHour', label: '5-hour' }, { id: 'weekly', label: 'Weekly' }] };
const gem = (five, weekly) => buildProviderView(GEMINI, raw(reading({ fiveHour: { percent: five }, weekly: { percent: weekly } })), { enabled: true, fiveHour: 'show', weekly: 'show' }, 80);

test('pickTrayState: the number follows the 5-hour meters, not the slow weekly ones', () => {
  const { claude, muse } = views(); // claude 19 / 43, muse weekly 53
  assert.deepEqual(pickTrayState([claude, muse], 'highest', T), { percent: 19, providerId: 'claude', meterId: 'fiveHour', alert: false });
  assert.deepEqual(pickTrayState([claude, muse], 'claude', T), { percent: 19, providerId: 'claude', meterId: 'fiveHour', alert: false });
  assert.equal(pickTrayState([cl(15, 60), gem(30, 10)], 'highest', T).percent, 30); // highest 5-hour wins over a bigger weekly
});

test('pickTrayState: a weekly meter takes over once it reaches the auto-appear level', () => {
  const s = pickTrayState([cl(15, 80), gem(30, 10)], 'highest', T);
  assert.deepEqual(s, { percent: 80, providerId: 'claude', meterId: 'weekly', alert: false });
  assert.equal(pickTrayState([cl(15, 74), gem(30, 10)], 'highest', T).percent, 30); // just under the level: still 5-hour
  assert.equal(pickTrayState([cl(15, 80), gem(30, 10)], 'claude', T).percent, 80); // same rule when pinned
  assert.equal(pickTrayState([cl(15, 80)], 'highest', { weekly: 85, danger: 95 }).percent, 15); // follows the auto-appear setting
});

test('pickTrayState: a weekly-only tool (Muse) is shown when nothing else is available', () => {
  assert.deepEqual(pickTrayState([mu(18)], 'highest', T), { percent: 18, providerId: 'muse', meterId: 'weekly', alert: false });
  assert.equal(pickTrayState([cl(15, 48), mu(18)], 'muse', T).percent, 18); // pinned
});

test('pickTrayState: a pinned tool that is missing or off falls back to highest', () => {
  const { claude, muse } = views();
  assert.equal(pickTrayState([claude, muse], 'chatgpt', T).percent, 19);
  const off = buildProviderView(MUSE, raw(reading({ weekly: { percent: 70 } })), { enabled: false, weekly: 'show' }, 80);
  assert.equal(pickTrayState([claude, off], 'muse', T).percent, 19);
});

test('pickTrayState: ignores hidden meters, signed-out and disabled providers', () => {
  const hidden = buildProviderView(CLAUDE, raw(reading({ fiveHour: { percent: 19 }, weekly: { percent: 90 } })), { enabled: true, fiveHour: 'show', weekly: 'hide' }, 80);
  assert.equal(pickTrayState([hidden], 'highest', T).percent, 19);
  const out = buildProviderView(MUSE, raw(reading({ weekly: { percent: 70 } }), { auth: 'signed-out' }), { enabled: true, weekly: 'show' }, 80);
  assert.deepEqual(pickTrayState([out], 'highest', T), { percent: null, providerId: null, meterId: null, alert: false });
  const off = buildProviderView(MUSE, raw(reading({ weekly: { percent: 70 } })), { enabled: false, weekly: 'show' }, 80);
  assert.equal(pickTrayState([off], 'highest', T).percent, null);
});

test('pickTrayState highest: a used-up meter is skipped and flagged with the alert dot', () => {
  const s = pickTrayState([cl(100, 48), gem(5, 7)], 'highest', T);
  assert.deepEqual(s, { percent: 5, providerId: 'gemini', meterId: 'fiveHour', alert: true });
  assert.equal(pickTrayState([cl(15, 48), gem(5, 7)], 'highest', T).alert, false);
  assert.equal(pickTrayState([cl(100, 48)], 'highest', T).percent, 48); // nothing else: its weekly is the fallback
});

test('pickTrayState highest: everything used up shows the limit itself, with no dot', () => {
  const s = pickTrayState([cl(100, 100), mu(100)], 'highest', T);
  assert.equal(s.percent, 100);
  assert.equal(s.alert, false);
});

test('pickTrayState pinned: never switches tool; the dot flags another tool at danger', () => {
  const calm = pickTrayState([cl(15, 48), mu(7)], 'muse', T);
  assert.deepEqual(calm, { percent: 7, providerId: 'muse', meterId: 'weekly', alert: false });
  const danger = pickTrayState([cl(15, 92), mu(7)], 'muse', T); // a weekly in danger counts for the dot
  assert.equal(danger.providerId, 'muse');
  assert.equal(danger.percent, 7);
  assert.equal(danger.alert, true);
  const maxedPinned = pickTrayState([cl(15, 48), mu(100)], 'muse', T); // pinned and used up: it stays on screen
  assert.equal(maxedPinned.percent, 100);
  assert.equal(maxedPinned.alert, false);
});

test('trayTooltip: a tool at its limit says so', () => {
  assert.equal(trayTooltip([cl(100, 48), mu(18)]), 'Claude 100% / 48% - at limit\nMuse 18%');
});

test('trayTooltip: one line per enabled provider, sign-in prompts included', () => {
  const { claude, muse } = views();
  const signedOut = buildProviderView({ id: 'chatgpt', name: 'ChatGPT', meterDefs: [] }, raw(null, { auth: 'signed-out' }), { enabled: true }, 80);
  const text = trayTooltip([claude, signedOut, muse]);
  assert.equal(text, 'Claude 19% / 43%\nChatGPT: sign in\nMuse 53%');
});

test('trayTooltip: empty and over-long cases', () => {
  assert.match(trayTooltip([]), /no AI tools selected/);
  const { claude } = views();
  const long = Array.from({ length: 20 }, (_, i) => ({ ...claude, name: `Provider number ${i}` }));
  const text = trayTooltip(long);
  assert.ok(text.length <= TOOLTIP_MAX);
  assert.ok(text.endsWith('…'));
});

test('macTrayTitle: plain percent, warning and limit symbols', () => {
  assert.equal(macTrayTitle(null, 90), 'AI --');
  assert.equal(macTrayTitle(42.4, 90), '42%');
  assert.equal(macTrayTitle(91, 90), '⚠ 91%');
  assert.equal(macTrayTitle(99.6, 90), '✕ 100%');
});
